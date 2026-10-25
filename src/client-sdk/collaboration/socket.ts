/**
 * Backpressured invited raw streams and their structured reference policy.
 */
import {
  decodeCollaborationResourceReference, encodeCollaborationResourceReference,
} from "@/shared/collaboration-reference";
import { previewWebSocketCloseCode } from "@/shared/preview";
import { utf8ByteLength } from "@/shared/encoding";
import { DomainError, isDomainError } from "../../domain/domain-error";
import type { MeshRelayDataStream } from "../../core/mesh-relay-data-stream";
import type { CollaborationClientRuntime } from "./engine";
import type { CollaborationClientLogger } from "./types";
import { isReadRecord } from "@/shared/record";
import { toMeshRelayCloseReason } from "../../core/mesh-relay-client-socket";

export const COLLABORATION_SOCKET_MAX_PENDING_BYTES = 1_024 * 1_024;
export const COLLABORATION_SOCKET_MAX_PENDING_FRAMES = 256;
export interface CollaborationSocketSink {
  send(data: string | Uint8Array): number | void;
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
}

export interface CollaborationSocketOperation {
  kind: "terminal" | "preview";
  path: string;
  workspaceId?: string;
}

export class CollaborationSocketBridge {
  private readonly opening = Promise.withResolvers<void>();
  readonly ready = this.opening.promise;
  private readonly abort = new AbortController();
  private readonly pending: Array<string | Uint8Array> = [];
  private pendingBytes = 0;
  private stream?: MeshRelayDataStream;
  private socket?: CollaborationSocketSink;
  private closed = false;
  private pumping?: Promise<void>;

  constructor(
    private readonly runtime: CollaborationClientRuntime,
    private readonly operation: CollaborationSocketOperation,
    private readonly log: CollaborationClientLogger = console,
  ) {
    // Readiness failure is also delivered to the sink; callers may await later.
    void this.ready.catch(() => {
      // The bridge's pump owns error reporting, including unopened channels.
    });
  }

  get bufferedAmount(): number {
    return this.pendingBytes + (this.stream?.bufferedAmount ?? 0);
  }

  start(socket: CollaborationSocketSink): void {
    if (this.socket) return;
    if (this.closed) throw new DomainError("collaboration_disconnected", "The workspace socket is closed.");
    this.socket = socket;
    this.pumping = this.pump();
    // This long-lived bridge reports failures through its public sink and owns
    // the rejection even when a host's synchronous socket callback cannot await.
    void this.pumping.catch((error: unknown) => {
      this.opening.reject(error);
      if (this.closed && !(isDomainError(error) && error.code === "mesh_relay_transport_cleanup_failed")) return;
      const code = isDomainError(error) ? error.code : "collaboration_socket_failed";
      this.log.error("Workspace socket forwarding failed", { code, error: String(error) });
      try {
        if (!this.closed) this.socket?.send(JSON.stringify({
          type: this.operation.kind === "terminal" ? "terminal.error" : "stream.error",
          code, message: "The workspace controller connection failed.", error: "Workspace connection failed.",
        }));
      } catch (failure) {
        this.log.warn("Workspace socket error could not be delivered", { error: String(failure) });
      } finally {
        this.close(1011, "Workspace connection failed");
      }
    });
  }

  send(data: string | Uint8Array): void {
    if (this.closed) throw new DomainError("collaboration_disconnected", "The workspace socket is closed.");
    if (this.stream) {
      this.stream.send(data);
      return;
    }
    const size = typeof data === "string" ? utf8ByteLength(data) : data.byteLength;
    if (this.pendingBytes + size > COLLABORATION_SOCKET_MAX_PENDING_BYTES
      || this.pending.length >= COLLABORATION_SOCKET_MAX_PENDING_FRAMES) {
      this.close(1013, "Workspace socket backpressure");
      throw new DomainError("collaboration_connection_capacity", "The workspace socket is full.");
    }
    this.pending.push(typeof data === "string" ? data : Uint8Array.from(data));
    this.pendingBytes += size;
  }

  private async pump(): Promise<void> {
    const stream = await this.runtime.client.openSocket({ ...this.operation, signal: this.abort.signal });
    this.stream = stream;
    try {
      if (this.closed) return;
      this.opening.resolve();
      for (const frame of this.pending.splice(0)) stream.send(frame);
      this.pendingBytes = 0;
      while (!this.closed) {
        const frame = await stream.next();
        if (frame.kind === "closed") {
          this.close(previewWebSocketCloseCode(frame.code), frame.reason);
          return;
        }
        if (!this.socket || this.socket.getBufferedAmount() > COLLABORATION_SOCKET_MAX_PENDING_BYTES) {
          throw new DomainError("collaboration_connection_capacity", "The local workspace socket is too slow.");
        }
        const result = this.socket.send(frame.kind === "text"
          ? qualifyCollaborationSocketFrame(this.runtime.connection.id, this.operation.kind, frame.text) : frame.bytes);
        if (result === 0) throw new DomainError("collaboration_disconnected", "The local workspace socket is closed.");
      }
    } finally {
      stream.abort(1000, "Workspace socket stopped");
      try {
        await stream.waitUntilTransportClosed();
      } catch (cause) {
        throw new DomainError("mesh_relay_transport_cleanup_failed", "The workspace socket transport did not close.", { cause });
      } finally {
        stream.dispose();
      }
    }
  }

  async stop(code = 1000, reason = "Local workspace socket closed"): Promise<void> {
    this.close(code, reason);
    await this.pumping;
  }

  close(code = 1000, reason = "Local workspace socket closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.opening.reject(new DomainError("collaboration_disconnected", "The workspace socket closed before opening."));
    this.abort.abort();
    this.pending.length = 0;
    this.pendingBytes = 0;
    this.stream?.abort(code, reason);
    this.socket?.close(previewWebSocketCloseCode(code), toMeshRelayCloseReason(reason));
  }
}

function parseSocketFrame(raw: string): Record<string, unknown> {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch (cause) {
    throw new DomainError("collaboration_response_invalid", "Invalid workspace socket JSON.", { cause });
  }
  if (!isReadRecord(frame)) throw new DomainError("collaboration_response_invalid", "Invalid workspace socket frame.");
  return frame;
}

export function qualifyCollaborationSocketFrame(connectionId: string, kind: CollaborationSocketOperation["kind"], raw: string): string {
  const frame = parseSocketFrame(raw);
  if (frame["type"] === "workspace.error") {
    return JSON.stringify({
      type: kind === "terminal" ? "terminal.error" : "stream.error",
      code: frame["code"], message: "The workspace operation is unavailable.", error: "Workspace access unavailable.",
    });
  }
  for (const [field, resourceKind] of Object.entries({
    terminalSessionId: "terminal", previewId: "preview", workspaceId: "workspace",
  })) {
    if (typeof frame[field] === "string") {
      frame[field] = encodeCollaborationResourceReference({ connectionId, resourceKind, resourceId: frame[field] });
    }
  }
  return JSON.stringify(frame);
}

export function collaborationTerminalOperation(id: string): { connectionId: string; operation: CollaborationSocketOperation } | undefined {
  const reference = decodeCollaborationResourceReference(id);
  if (!reference) return undefined;
  if (reference.resourceKind !== "terminal") throw new DomainError("collaboration_reference_invalid", "A terminal reference is required.");
  return {
    connectionId: reference.connectionId,
    operation: { kind: "terminal", path: `/api/terminal?terminalSessionId=${encodeURIComponent(reference.resourceId)}` },
  };
}

export function collaborationPreviewOperation(raw: string): {
  connectionId: string;
  operation: CollaborationSocketOperation;
  hello: string;
} | undefined {
  const frame = parseSocketFrame(raw);
  if (!isReadRecord(frame) || frame["type"] !== "hello" || !isReadRecord(frame["target"])) return undefined;
  const target = frame["target"];
  const reference = typeof target["reference"] === "string"
    ? decodeCollaborationResourceReference(target["reference"]) : undefined;
  if (!reference) return undefined;
  if (target["kind"] !== "workspace" || reference.resourceKind !== "workspace") {
    throw new DomainError("collaboration_operation_forbidden", "Only a shared workspace can host this preview.");
  }
  target["reference"] = reference.resourceId;
  if (isReadRecord(frame["code"])) {
    for (const field of ["chat", "task"]) {
      const value = frame["code"][field];
      if (value === undefined) continue;
      const codeReference = typeof value === "string" ? decodeCollaborationResourceReference(value) : undefined;
      // Unqualified selectors resolve only within the controller's authorized workspace.
      if (!codeReference) continue;
      if (codeReference.connectionId !== reference.connectionId || codeReference.resourceKind !== field) {
        throw new DomainError("collaboration_mixed_sources", "The code preview must use the same controller.");
      }
      frame["code"][field] = codeReference.resourceId;
    }
  }
  return {
    connectionId: reference.connectionId,
    operation: {
      kind: "preview", path: "/api/previews/bridge", workspaceId: reference.resourceId,
    },
    hello: JSON.stringify(frame),
  };
}
