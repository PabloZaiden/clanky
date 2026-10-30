import { z } from "zod";
import { createLogger } from "@pablozaiden/webapp/server";
import type { HarnessConversationBinding } from "@/shared/harness-control";
import { SECRET_TOOL_NAME, type SecretFileResult } from "@/shared/harness-secrets";
import { ReplyToSecretSchema, RequestSecretSchema } from "@/contracts/schemas/harness-secret";
import { harnessSecretFiles, secretNamespace } from "../core/harness-secret-files";
import type { HarnessEventHub } from "./harness-event-hub";
import { HarnessError } from "./harness-errors";

const log = createLogger("native-secret-tool");
const { $schema: _schema, ...schema } = z.toJSONSchema(RequestSecretSchema);
const inputSchema = z.record(z.string(), z.json()).parse(schema);
export const secretToolDefinition = {
  name: SECRET_TOOL_NAME,
  description: "Request a secret for a shell CLI using a private user form. Never ask for secrets in chat. Call every time you need the secret, with the same identifier within this conversation: a valid private file is reused for 24 hours, without extending expiry; otherwise this tool waits for the user. Returns only path and expiresAt, never the value. Read the file inside your command using stdin/a CLI file option, or TOKEN=\"$(cat -- <path>)\" cli. Never print it, use shell tracing, put it in command arguments, or copy it to repository files. A worker restart invalidates old files. Interactive root conversations only.",
  inputSchema,
};

interface PendingSecret {
  binding: HarnessConversationBinding;
  key: string;
  signal: AbortSignal;
  response: ReturnType<typeof Promise.withResolvers<SecretFileResult>>;
  writing: boolean;
}

export class SecretCoordinator {
  private readonly pending = new Map<string, PendingSecret>();

  constructor(private readonly events: HarnessEventHub) {}

  async request(binding: HarnessConversationBinding, input: unknown, signal: AbortSignal): Promise<SecretFileResult> {
    if (binding.questionPolicy !== "interactive" || binding.secretFiles !== 1) {
      throw new HarnessError("harness_unsupported_feature", "Secrets are unavailable in autonomous executions.");
    }
    const parsed = RequestSecretSchema.safeParse(input);
    if (!parsed.success) throw new HarnessError("harness_request_failed", "Use the documented secret request parameters.");
    signal.throwIfAborted();
    const key = secretNamespace(binding, parsed.data.identifier);
    const stored = await harnessSecretFiles.get(key);
    signal.throwIfAborted();
    if (stored) return { status: "saved", ...stored };
    const existing = [...this.pending.values()].find((entry) => entry.key === key);
    if (existing) return await existing.response.promise;
    if (this.pending.size >= 64) throw new HarnessError("harness_input_capacity", "Too many secrets are awaiting input.");
    const requestId = crypto.randomUUID();
    const response = Promise.withResolvers<SecretFileResult>();
    this.pending.set(requestId, { binding, key, signal, response, writing: false });
    const abort = (): void => {
      this.pending.delete(requestId);
      response.reject(new HarnessError("harness_transport_closed", "The secret request ended."));
      this.resolved(binding, requestId, "cancelled");
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      this.events.publish(binding.nativeId, {
        type: "question.asked", sessionId: binding.nativeId, requestId,
        scope: { kind: "principal" }, blocking: true, responseMode: "callback",
        secretIdentifier: parsed.data.identifier,
        questions: [{ header: parsed.data.label, question: parsed.data.reason, options: [], custom: false }],
      });
      return await response.promise;
    } finally {
      signal.removeEventListener("abort", abort);
      this.pending.delete(requestId);
    }
  }

  async reply(requestId: string, value: string | null): Promise<void> {
    const entry = this.pending.get(requestId);
    if (!entry || entry.signal.aborted || entry.writing) {
      throw new HarnessError("harness_question_closed", "The secret request is unavailable or already answered.");
    }
    const parsed = ReplyToSecretSchema.safeParse({ value });
    if (!parsed.success) throw new HarnessError("harness_request_failed", "The private secret response is invalid.");
    entry.writing = true;
    try {
      const result: SecretFileResult = value === null
        ? { status: "declined" }
        : { status: "saved", ...await harnessSecretFiles.save(entry.key, value, entry.signal) };
      entry.signal.throwIfAborted();
      this.pending.delete(requestId);
      this.resolved(entry.binding, requestId, value === null ? "cancelled" : "answered");
      entry.response.resolve(result);
    } catch {
      log.error("The private secret file could not be delivered.");
      entry.writing = false;
      throw new HarnessError("harness_request_failed", "The private secret file could not be delivered.");
    }
  }

  cancel(sessionId: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.binding.nativeId !== sessionId) continue;
      this.pending.delete(id);
      this.resolved(entry.binding, id, "cancelled");
      entry.response.reject(new HarnessError("harness_transport_closed", "The secret request ended."));
    }
  }

  private resolved(binding: HarnessConversationBinding, requestId: string, outcome: "answered" | "cancelled"): void {
    this.events.publish(binding.nativeId, { type: "question.resolved", requestId, outcome, scope: { kind: "principal" } });
  }
}
