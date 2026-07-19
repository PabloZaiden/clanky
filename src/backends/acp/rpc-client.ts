/**
 * JSON-RPC protocol client and dispatcher for the ACP backend.
 *
 * Owns outbound request bookkeeping: ID allocation, message serialization,
 * pending-request storage, timeout registration/clearing, response/error
 * correlation, and rejection on transport close or process exit. Inbound
 * server-initiated method messages (notifications and requests such as
 * `session/request_permission`) are forwarded to the notification sink so
 * numeric outbound response IDs are never confused with inbound string IDs.
 */

import { log } from "@pablozaiden/webapp/server";
import { isRecord } from "./json-helpers";
import { AcpError, createAcpRpcError } from "./errors";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./types";
import type { JsonRpcMessage, PendingRequest } from "./types";
import type { RpcNotificationSink, RpcRequester, RpcTransport } from "./contracts";

export interface RpcClientDeps {
  transport: RpcTransport;
  /** Guard invoked before allocating a request; throws when not connected. */
  ensureUsable: () => void;
  /** Sink for inbound server-initiated method messages. */
  onNotification: RpcNotificationSink;
}

export class RpcClient implements RpcRequester {
  /** Track pending JSON-RPC requests by numeric outbound ID. */
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private nextRequestId = 1;

  constructor(private readonly deps: RpcClientDeps) {}

  /**
   * Route a parsed inbound JSON-RPC message. Server-initiated method messages
   * are dispatched to the notification sink; numeric-id messages are matched to
   * a pending outbound request and resolved or rejected.
   */
  handleMessage(message: JsonRpcMessage): void {
    log.trace("[AcpBackend] Received RPC message", {
      method: message.method,
      id: message.id,
      params: message.params,
      result: message.result,
      error: message.error,
    });

    if (message.method && isRecord(message.params)) {
      this.deps.onNotification(message);
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timeout);
      this.pendingRequests.delete(message.id);

      if (message.error) {
        pending.reject(createAcpRpcError(message.error));
        return;
      }

      pending.resolve(message.result);
    }
  }

  writeMessage(message: JsonRpcMessage): void {
    this.deps.transport.write(message);
  }

  async sendRequest<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    this.deps.ensureUsable();

    const id = this.nextRequestId;
    this.nextRequestId += 1;

    const message: JsonRpcMessage = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new AcpError(
          "acp_request_timed_out",
          `ACP request timed out for method '${method}'`,
          { details: { method } },
        ));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (value: unknown) => {
          log.trace("[AcpBackend] RPC request resolved", {
            id,
            method,
            result: value,
          });
          resolve(value as T);
        },
        reject,
        timeout,
      });

      try {
        this.deps.transport.write(message);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Reject and clear every pending request, clearing their timers. */
  rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  /** Clear pending request bookkeeping and timers without rejecting. */
  clearPending(): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingRequests.clear();
  }
}
