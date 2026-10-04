/**
 * Owns native user-input callbacks until answer, native settlement or disconnect.
 */

import { z } from "zod";
import type { CodexSessionService } from "./session-service";
import type { HarnessEventHub } from "../harness-event-hub";
import { HarnessError } from "../harness-errors";

const QuestionRequestSchema = z.object({
  threadId: z.string(), turnId: z.string(), itemId: z.string(),
  questions: z.array(z.object({
    id: z.string(), header: z.string(), question: z.string(), isOther: z.boolean(),
    options: z.array(z.object({ label: z.string(), description: z.string() })).nullable(),
  })).max(100),
});

export class CodexQuestionCoordinator {
  private readonly pending = new Map<string, {
    questionIds: string[];
    response: ReturnType<typeof Promise.withResolvers<unknown>>;
  }>();

  constructor(private readonly dependencies: { sessions: CodexSessionService; events: HarnessEventHub }) {}

  async handle(request: { method: string; params: unknown; signal: AbortSignal }): Promise<unknown> {
    if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") return { decision: "accept" };
    if (request.method !== "item/tool/requestUserInput") throw new HarnessError("harness_unsupported_feature", "The native callback is unsupported.");
    const params = QuestionRequestSchema.parse(request.params);
    const tracked = this.dependencies.sessions.getThread(params.threadId);
    const scope = this.dependencies.sessions.getScope(params.threadId);
    if (!tracked || !scope) throw new HarnessError("harness_session_not_owned", "The native question has no owned conversation.");
    if (this.pending.size >= 256) throw new HarnessError("harness_request_failed", "Native question capacity reached.");
    const requestId = crypto.randomUUID();
    const response = Promise.withResolvers<unknown>();
    this.pending.set(requestId, { questionIds: params.questions.map((question) => question.id), response });
    const abort = (): void => response.reject(new HarnessError("harness_transport_closed", "The native question has expired."));
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      if (request.signal.aborted) throw new HarnessError("harness_transport_closed", "The native question has expired.");
      this.dependencies.events.publish(tracked.rootId, {
        type: "question.asked", requestId, sessionId: tracked.rootId, scope,
        questions: params.questions.map((question) => ({
          header: question.header, question: question.question, custom: question.isOther, options: question.options ?? [],
        })),
      });
      return await response.promise;
    } finally {
      request.signal.removeEventListener("abort", abort);
      this.pending.delete(requestId);
    }
  }

  reply(requestId: string, answers: string[][]): void {
    const pending = this.pending.get(requestId);
    if (!pending) throw new HarnessError("harness_request_failed", "The native question has expired.");
    if (answers.length !== pending.questionIds.length) throw new HarnessError("harness_request_failed", "Native question answers do not match the request.");
    pending.response.resolve({ answers: Object.fromEntries(pending.questionIds.map((id, index) => [id, { answers: answers[index]! }])) });
  }
}
