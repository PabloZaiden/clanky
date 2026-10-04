/**
 * Owns native question callbacks and expires them with their connection.
 */

import type { SessionConfig } from "@github/copilot-sdk";
import type { HarnessEventHub } from "../harness-event-hub";
import { HarnessError } from "../harness-errors";
import type { HarnessQuestionPolicy } from "@/shared/harness-control";

type QuestionHandler = NonNullable<SessionConfig["onUserInputRequest"]>;
type NativeAnswer = Awaited<ReturnType<QuestionHandler>>;

export class CopilotQuestionCoordinator {
  private readonly pending = new Map<string, {
    sessionId: string;
    choices: readonly string[];
    response: ReturnType<typeof Promise.withResolvers<NativeAnswer>>;
  }>();

  constructor(private readonly events: HarnessEventHub) {}

  handler(policy: HarnessQuestionPolicy | undefined): QuestionHandler {
    return async (request, invocation) => {
      if (policy !== "interactive") throw new HarnessError("harness_unsupported_feature", "Human input is disabled for this autonomous execution.");
      if (this.pending.size >= 256) throw new HarnessError("harness_request_failed", "Too many pending native questions.");
      const requestId = crypto.randomUUID();
      const response = Promise.withResolvers<NativeAnswer>();
      this.pending.set(requestId, {
        sessionId: invocation.sessionId,
        choices: request.choices ?? [],
        response,
      });
      this.events.publish(invocation.sessionId, {
        type: "question.asked",
        requestId,
        sessionId: invocation.sessionId,
        // The public callback supplies no agent ID; do not invent principal attribution.
        scope: { kind: "unknown", native: { adapter: "copilot", conversationId: invocation.sessionId } },
        questions: [{
          question: request.question,
          header: "",
          options: (request.choices ?? []).map((label) => ({ label, description: "" })),
          custom: request.allowFreeform ?? true,
        }],
      });
      try {
        return await response.promise;
      } finally {
        this.pending.delete(requestId);
      }
    };
  }

  reply(requestId: string, answers: string[][]): void {
    const pending = this.pending.get(requestId);
    if (!pending) throw new HarnessError("harness_request_failed", "The native question has expired.");
    const answer = answers.flat().join(", ");
    pending.response.resolve({ answer, wasFreeform: !pending.choices.includes(answer) });
    this.publishResolved(requestId, pending.sessionId, "answered");
  }

  expire(sessionId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.sessionId === sessionId) {
        pending.response.reject(new HarnessError("harness_transport_closed", "The native question connection closed."));
        this.publishResolved(id, sessionId, "expired");
      }
    }
  }

  private publishResolved(requestId: string, sessionId: string, outcome: "answered" | "expired"): void {
    this.events.publish(sessionId, { type: "question.resolved", requestId, outcome,
      scope: { kind: "unknown", native: { adapter: "copilot", conversationId: sessionId } } });
  }
}
