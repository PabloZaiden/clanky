/**
 * Validates JSON-RPC frames and owns callbacks to the Clanky client.
 */

export type JsonRpcId = number | string;

export interface JsonRpcMessage {
  error?: { code: number; message: string };
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
}

interface PendingClientRequest {
  reject: (error: Error) => void;
  resolve: (message: JsonRpcMessage) => void;
  timer: ReturnType<typeof setTimeout>;
}

const CLIENT_REQUEST_TIMEOUT_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonRpcMessage(value: unknown): JsonRpcMessage {
  if (!isRecord(value)) {
    throw new Error("The Codex fixture received a non-object JSON-RPC frame.");
  }
  const id = value["id"];
  if (id !== undefined && typeof id !== "string" && typeof id !== "number") {
    throw new Error("The Codex fixture received an invalid JSON-RPC id.");
  }
  const method = value["method"];
  if (method !== undefined && typeof method !== "string") {
    throw new Error("The Codex fixture received an invalid JSON-RPC method.");
  }
  const rawError = value["error"];
  if (
    rawError !== undefined
    && (
      !isRecord(rawError)
      || typeof rawError["code"] !== "number"
      || typeof rawError["message"] !== "string"
    )
  ) {
    throw new Error("The Codex fixture received an invalid JSON-RPC error.");
  }
  return {
    ...(id === undefined ? {} : { id }),
    ...(method === undefined ? {} : { method }),
    ...(Object.hasOwn(value, "params") ? { params: value["params"] } : {}),
    ...(Object.hasOwn(value, "result") ? { result: value["result"] } : {}),
    ...(isRecord(rawError) && typeof rawError["code"] === "number" && typeof rawError["message"] === "string"
      ? { error: { code: rawError["code"], message: rawError["message"] } }
      : {}),
  };
}

export class CodexJsonRpcSession {
  private readonly pendingRequests = new Map<JsonRpcId, PendingClientRequest>();
  private nextRequestId = 0;

  constructor(private readonly writeMessage: (message: Record<string, unknown>) => void) {}

  notify(method: string, params: Record<string, unknown>): void {
    this.writeMessage({ method, params });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.writeMessage({ id, result });
  }

  respondWithError(id: JsonRpcId, error: { code: number; message: string }): void {
    this.writeMessage({ id, error });
  }

  requestClient(method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> {
    const id = `clanky-tool-${String(++this.nextRequestId)}`;
    return new Promise<JsonRpcMessage>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        rejectPromise(new Error(`Clanky did not answer ${method} within ${CLIENT_REQUEST_TIMEOUT_MS}ms.`));
      }, CLIENT_REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      });
      try {
        this.writeMessage({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  receiveResponse(frame: JsonRpcMessage): void {
    if (frame.method || frame.id === undefined) {
      return;
    }
    const pending = this.pendingRequests.get(frame.id);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.error) {
      pending.reject(new Error(frame.error.message));
    } else {
      pending.resolve(frame);
    }
  }

  close(): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The Codex fixture closed before the request completed."));
    }
    this.pendingRequests.clear();
  }
}
