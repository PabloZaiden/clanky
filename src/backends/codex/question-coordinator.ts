/**
 * Owns native user-input callbacks until answer, native settlement or disconnect.
 */

import { z } from "zod";
import type { CodexSessionService } from "./session-service";
import type { HarnessEventHub } from "../harness-event-hub";
import { HarnessError } from "../harness-errors";
import type { CodexRuntime } from "./runtime";
import type { HarnessEventScope } from "@/shared/harness-events";

const QuestionRequestSchema = z.object({
  threadId: z.string(), turnId: z.string(), itemId: z.string(),
  questions: z.array(z.object({
    id: z.string(), header: z.string(), question: z.string(), isOther: z.boolean(),
    options: z.array(z.object({ label: z.string(), description: z.string() })).nullable(),
  })).max(100),
  isBlocking: z.boolean().optional(),
});

export class CodexQuestionCoordinator {
  private readonly pending = new Map<string, {
    questionIds: string[];
    threadId: string;
    turnId: string;
    rootId: string;
    scope: HarnessEventScope;
    response: ReturnType<typeof Promise.withResolvers<unknown>>;
  }>();

  private readonly unsubscribe: () => void;
  constructor(private readonly dependencies: { sessions: CodexSessionService; events: HarnessEventHub; runtime: CodexRuntime }) {
    this.unsubscribe = dependencies.runtime.rpc.onNotification((event) => {
      if (event.method !== "turn/completed") return;
      for (const [id, pending] of this.pending) {
        if (pending.threadId === event.params.threadId && pending.turnId === event.params.turn.id) {
          pending.response.reject(new HarnessError("harness_transport_closed", "The question's native turn ended."));
          this.publishResolved(id, pending, "expired");
        }
      }
    });
  }

  async handle(request: { method: string; params: unknown; signal: AbortSignal }): Promise<unknown> {
    if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") return { decision: "accept" };
    if (request.method !== "item/tool/requestUserInput") throw new HarnessError("harness_unsupported_feature", "The native callback is unsupported.");
    const params = QuestionRequestSchema.parse(request.params);
    const tracked = this.dependencies.sessions.getThread(params.threadId);
    const scope = this.dependencies.sessions.getScope(params.threadId);
    if (!tracked || !scope) throw new HarnessError("harness_session_not_owned", "The native question has no owned conversation.");
    if (this.dependencies.sessions.get(tracked.rootId).info.binding?.questionPolicy !== "interactive") {
      throw new HarnessError("harness_unsupported_feature", "Human input is disabled for this autonomous execution.");
    }
    if (this.pending.size >= 256) throw new HarnessError("harness_request_failed", "Native question capacity reached.");
    const requestId = crypto.randomUUID();
    const response = Promise.withResolvers<unknown>();
    const pending = { questionIds: params.questions.map((question) => question.id), response,
      threadId: params.threadId, turnId: params.turnId, rootId: tracked.rootId, scope };
    this.pending.set(requestId, pending);
    const abort = (): void => {
      response.reject(new HarnessError("harness_transport_closed", "The native question has expired."));
      this.dependencies.events.publish(tracked.rootId, { type: "question.resolved", requestId, outcome: "expired", scope });
    };
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      if (request.signal.aborted) throw new HarnessError("harness_transport_closed", "The native question has expired.");
      this.dependencies.events.publish(tracked.rootId, {
        type: "question.asked", requestId, sessionId: tracked.rootId, scope,
        // Native default mode reports isBlocking=false, but the tool still
        // awaits this server callback. Only async agent-message questions do not.
        blocking: true, responseMode: "callback",
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
    this.publishResolved(requestId, pending, "answered");
    this.pending.delete(requestId);
  }

  close(): void {
    this.unsubscribe();
    for (const [id, pending] of this.pending) {
      pending.response.reject(new HarnessError("harness_transport_closed", "The native question connection closed."));
      this.publishResolved(id, pending, "expired");
    }
    this.pending.clear();
  }

  private publishResolved(requestId: string, pending: { rootId: string; scope: HarnessEventScope }, outcome: "answered" | "expired"): void {
    this.dependencies.events.publish(pending.rootId, { type: "question.resolved", requestId, outcome, scope: pending.scope });
  }
}
