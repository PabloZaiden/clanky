/**
 * Owns JSON-RPC framing, bounded requests, concurrent callbacks and deadlines.
 */

import { z } from "zod";
import { createLogger } from "@pablozaiden/webapp/server";
import { HarnessError } from "../harness-errors";
import { CODEX_NOTIFICATION_METHODS, type CodexMethods, type CodexNotification } from "./protocol";

const FrameSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }).optional(),
});
const log = createLogger("codex-rpc");

export class CodexRpcError extends HarnessError {
  constructor(readonly method: string, readonly rpcCode: number, readonly rpcData: unknown, message: string) {
    super(rpcCode === -32601 ? "harness_unsupported_feature" : "harness_request_failed", message);
  }
}

interface NativeRequest {
  id: string | number;
  method: string;
  params: unknown;
  signal: AbortSignal;
}

export class CodexRpcSession {
  private readonly requests = new Map<number, {
    method: string;
    deferred: ReturnType<typeof Promise.withResolvers<unknown>>;
  }>();
  private readonly callbacks = new Map<string | number, AbortController>();
  private readonly callbackTasks = new Set<Promise<void>>();
  private readonly listeners = new Set<(event: CodexNotification) => void>();
  private nextId = 0;
  private closed = false;
  private handler?: (request: NativeRequest) => Promise<unknown>;

  constructor(private readonly write: (frame: string) => Promise<void>) {}

  setRequestHandler(handler: (request: NativeRequest) => Promise<unknown>): void {
    this.handler = handler;
  }

  onNotification(listener: (event: CodexNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isOpen(): boolean { return !this.closed; }

  async request<M extends keyof CodexMethods>(method: M, params: CodexMethods[M][0]): Promise<CodexMethods[M][1]> {
    if (this.closed) throw new HarnessError("harness_transport_closed", "The Codex protocol session is closed.");
    if (this.requests.size >= 256) throw new HarnessError("harness_request_failed", "Too many pending Codex protocol requests.");
    const id = ++this.nextId;
    const deferred = Promise.withResolvers<unknown>();
    this.requests.set(id, { method, deferred });
    const timer = setTimeout(() => deferred.reject(new HarnessError("harness_request_failed", "The Codex protocol request timed out.")), 30_000);
    try {
      const [, result] = await Promise.all([
        this.write(JSON.stringify({ id, method, params })), deferred.promise,
      ]);
      // Payloads are from the version-gated official runtime; the envelope is validated below.
      return result as CodexMethods[M][1];
    } finally {
      clearTimeout(timer);
      this.requests.delete(id);
    }
  }

  async initialized(): Promise<void> {
    await this.write(JSON.stringify({ method: "initialized", params: {} }));
  }

  receive(line: string): void {
    let frame: z.infer<typeof FrameSchema>;
    try { frame = FrameSchema.parse(JSON.parse(line)); } catch (error) {
      throw new HarnessError("harness_event_gap", "The Codex runtime emitted an invalid protocol frame.", { cause: error });
    }
    if (frame.method && frame.id !== undefined) {
      if (this.callbacks.size >= 256) throw new HarnessError("harness_request_failed", "Too many concurrent Codex callbacks.");
      const controller = new AbortController();
      this.callbacks.set(frame.id, controller);
      const task = this.handleRequest({ id: frame.id, method: frame.method, params: frame.params, signal: controller.signal })
        .finally(() => { this.callbacks.delete(frame.id!); this.callbackTasks.delete(task); });
      this.callbackTasks.add(task);
      // Reader dispatch stays concurrent; teardown awaits every callback task.
      void task.catch((error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error))));
    } else if (frame.method) {
      if (frame.method === "serverRequest/resolved") {
        const resolved = z.object({ requestId: z.union([z.string(), z.number()]) }).parse(frame.params);
        this.callbacks.get(resolved.requestId)?.abort();
      }
      if (CODEX_NOTIFICATION_METHODS.has(frame.method as CodexNotification["method"])) {
        const event = frame as CodexNotification;
        for (const listener of this.listeners) listener(event);
      }
    } else if (typeof frame.id === "number") {
      const pending = this.requests.get(frame.id);
      if (!pending) return;
      if (frame.error) {
        pending.deferred.reject(new CodexRpcError(pending.method, frame.error.code, frame.error.data, frame.error.message));
      } else if ("result" in frame) {
        pending.deferred.resolve(frame.result);
      } else throw new HarnessError("harness_event_gap", "Codex returned neither a result nor a protocol error.");
    }
  }

  fail(error: Error): void {
    this.closed = true;
    for (const request of this.requests.values()) request.deferred.reject(error);
    for (const callback of this.callbacks.values()) callback.abort();
    this.listeners.clear();
  }

  async close(): Promise<void> {
    this.fail(new HarnessError("harness_transport_closed", "The native Codex runtime closed."));
    await Promise.allSettled(this.callbackTasks);
    this.requests.clear();
    this.callbacks.clear();
  }

  private async handleRequest(request: NativeRequest): Promise<void> {
    let response: { result: unknown } | { error: { code: number; message: string } };
    try {
      if (!this.handler) throw new HarnessError("harness_unsupported_feature", "The native callback is unsupported.");
      response = { result: await this.handler(request) };
    } catch (error) {
      if (!(error instanceof HarnessError && (error.code === "harness_unsupported_feature" || error.code === "harness_transport_closed"))) {
        log.error("Native callback failed", { method: request.method });
      }
      response = { error: {
        code: error instanceof HarnessError && error.code === "harness_unsupported_feature" ? -32601 : -32000,
        message: "The Clanky native callback could not complete.",
      } };
    }
    if (!this.closed && !request.signal.aborted) await this.write(JSON.stringify({ id: request.id, ...response }));
  }
}
