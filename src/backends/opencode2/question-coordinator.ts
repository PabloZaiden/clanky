/**
 * Bridges owned native forms without flattening conditional or external forms.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import type { FormInfo1, OpenCodeClient, SessionFormReplyInput } from "@opencode/client";
import type { HarnessEventHub } from "../harness-event-hub";
import type { OpenCodeSessionService } from "./session-service";
import { HarnessError } from "../harness-errors";

const log = createLogger("opencode2-questions");

export class OpenCodeQuestionCoordinator {
  private readonly pending = new Map<string, FormInfo1>();
  private readonly abort = new AbortController();
  private readonly observing: Promise<void>;

  constructor(private readonly dependencies: { client: OpenCodeClient; sessions: OpenCodeSessionService; events: HarnessEventHub }) {
    this.observing = this.observe();
  }
  async reply(requestId: string, answers: string[][]): Promise<void> {
    const form = this.pending.get(requestId);
    if (!form) throw new HarnessError("harness_request_failed", "The native form has expired.");
    if (answers.length !== form.fields.length) throw new HarnessError("harness_request_failed", "The native answers do not match the form.");
    const answer: Record<string, SessionFormReplyInput["answer"][string]> = {};
    for (const [index, field] of form.fields.entries()) {
      const values = answers[index]!;
      const value = values.join(", ");
      if (field.type === "external") throw new HarnessError("harness_unsupported_feature", "External native forms cannot use the chat question interface.");
      if (field.type === "boolean") {
        if (value !== "true" && value !== "false") throw new HarnessError("harness_request_failed", "A native boolean answer is invalid.");
        answer[field.key] = value === "true";
      } else if (field.type === "number" || field.type === "integer") {
        const number = Number(value);
        if (!value || !Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number))) throw new HarnessError("harness_request_failed", "A native numeric answer is invalid.");
        answer[field.key] = number;
      } else answer[field.key] = field.type === "multiselect" ? values : value;
    }
    await this.dependencies.client.session.form.reply({ sessionID: form.sessionID, formID: form.id, answer });
    this.pending.delete(requestId);
  }
  async close(): Promise<void> {
    this.abort.abort();
    await this.observing;
    this.pending.clear();
  }
  private async observe(): Promise<void> {
    try {
      for await (const event of this.dependencies.client.event.subscribe({ signal: this.abort.signal })) {
        if (event.type === "form.created") this.receive(event.data.form);
        if (event.type === "form.replied" || event.type === "form.cancelled") this.pending.delete(event.data.id);
      }
    } catch (error) {
      if (!this.abort.signal.aborted) {
        log.error("Native form observation failed");
        for (const id of this.dependencies.sessions.roots()) this.dependencies.events.failSession(id, new HarnessError("harness_event_gap", "Native form observation failed.", { cause: error }));
      }
    }
  }
  private receive(form: FormInfo1): void {
    const tracked = this.dependencies.sessions.getTracked(form.sessionID);
    if (!tracked) return;
    const native = { adapter: "opencode2" as const, conversationId: form.sessionID };
    const scope = tracked.rootId === form.sessionID ? { kind: "principal" as const, native } : { kind: "child" as const, activityId: form.sessionID, native };
    if (form.fields.some((field) => field.type === "external" || ("when" in field && field.when?.length) || ("hidden" in field && field.hidden))) {
      log.warn("Native form requires unsupported conditional or external interaction", { formId: form.id });
      this.dependencies.events.publish(tracked.rootId, {
        type: "error", code: "harness_unsupported_feature", message: "This native form requires an unsupported conditional or external interaction.",
        scope,
      });
      return;
    }
    if (this.pending.size >= 256) throw new HarnessError("harness_request_failed", "Native form capacity reached.");
    this.pending.set(form.id, form);
    this.dependencies.events.publish(tracked.rootId, {
      type: "question.asked", requestId: form.id, sessionId: tracked.rootId,
      scope,
      questions: form.fields.map((field) => ({
        question: "description" in field ? field.description ?? field.title ?? field.key : field.title ?? field.key,
        header: field.title ?? "",
        multiple: field.type === "multiselect",
        custom: field.type === "string" ? field.custom !== false : field.type === "number" || field.type === "integer",
        options: field.type === "boolean" ? [{ label: "true", description: "" }, { label: "false", description: "" }]
          : "options" in field ? (field.options ?? []).map((option) => ({ label: option.value, description: option.label ?? "" })) : [],
      })),
    });
  }
}
