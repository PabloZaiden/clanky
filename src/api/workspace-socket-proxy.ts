/**
 * Backpressured local raw sockets for resources owned by an invited controller.
 */
import { createLogger } from "@pablozaiden/webapp/server";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import {
  decodeCollaborationResourceReference, encodeCollaborationResourceReference,
} from "@/shared/collaboration-reference";
import { previewWebSocketCloseCode } from "@/shared/preview";
import { runWithCurrentUser } from "../context/user-context";
import { DomainError, isDomainError } from "../domain/domain-error";
import type { MeshRelayDataStream } from "../core/mesh-relay-data-stream";
import { workspaceConnections, type WorkspaceConnectionRuntime } from "../core/workspace-connections";
import { isReadRecord } from "../core/resource-read-service";

const log = createLogger("api:workspace-socket-proxy");
const MAX_PENDING_BYTES = 1_024 * 1_024;
interface ProxySocket {
  send(data: string | Uint8Array): number | void;
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
}

export class WorkspaceSocketProxy {
  private readonly abort = new AbortController();
  private readonly pending: Array<string | Uint8Array> = [];
  private pendingBytes = 0;
  private stream?: MeshRelayDataStream;
  private socket?: ProxySocket;
  private closed = false;

  constructor(
    private readonly runtime: WorkspaceConnectionRuntime,
    private readonly operation: { kind: "terminal" | "preview"; path: string; workspaceId?: string },
  ) {}

  start(socket: ProxySocket): void {
    if (this.socket) return;
    this.socket = socket;
    // The raw socket owns this long-lived bridge; failures close its public transport.
    void this.pump().catch((error: unknown) => {
      if (this.closed) return;
      const code = isDomainError(error) ? error.code : "collaboration_socket_failed";
      log.error("Workspace socket forwarding failed", { code, error: String(error) });
      this.socket?.send(JSON.stringify({
        type: this.operation.kind === "terminal" ? "terminal.error" : "stream.error",
        code, message: "The workspace controller connection failed.", error: "Workspace connection failed.",
      }));
      this.close(1011, "Workspace connection failed");
    });
  }

  send(data: string | Uint8Array): void {
    if (this.closed) throw new DomainError("collaboration_disconnected", "The workspace socket is closed.");
    if (this.stream) {
      this.stream.send(data);
      return;
    }
    const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    if (this.pendingBytes + size > MAX_PENDING_BYTES || this.pending.length >= 256) {
      this.close(1013, "Workspace socket backpressure");
      throw new DomainError("collaboration_connection_capacity", "The workspace socket is full.");
    }
    this.pending.push(typeof data === "string" ? data : Uint8Array.from(data));
    this.pendingBytes += size;
  }

  private async pump(): Promise<void> {
    const stream = await this.runtime.client.openSocket({ ...this.operation, signal: this.abort.signal });
    this.stream = stream;
    if (this.closed) {
      stream.close(1000, "Local socket closed");
      stream.dispose();
      return;
    }
    try {
      for (const frame of this.pending.splice(0)) stream.send(frame);
      this.pendingBytes = 0;
      while (!this.closed) {
        const frame = await stream.next();
        if (frame.kind === "closed") {
          this.close(previewWebSocketCloseCode(frame.code), frame.reason);
          return;
        }
        if (!this.socket || this.socket.getBufferedAmount() > MAX_PENDING_BYTES) {
          throw new DomainError("collaboration_connection_capacity", "The local workspace socket is too slow.");
        }
        const result = this.socket.send(frame.kind === "text" ? this.qualifyFrame(frame.text) : frame.bytes);
        if (result === 0) throw new DomainError("collaboration_disconnected", "The local workspace socket is closed.");
      }
    } finally {
      stream.dispose();
    }
  }

  private qualifyFrame(raw: string): string {
    const frame: unknown = JSON.parse(raw);
    if (!isReadRecord(frame)) throw new DomainError("collaboration_response_invalid", "Invalid workspace socket frame.");
    if (frame["type"] === "workspace.error") {
      return JSON.stringify({
        type: this.operation.kind === "terminal" ? "terminal.error" : "stream.error",
        code: frame["code"], message: "The workspace operation is unavailable.", error: "Workspace access unavailable.",
      });
    }
    for (const [field, resourceKind] of Object.entries({
      terminalSessionId: "terminal", previewId: "preview", workspaceId: "workspace",
    })) {
      if (typeof frame[field] === "string") {
        frame[field] = encodeCollaborationResourceReference({
          connectionId: this.runtime.connection.id, resourceKind, resourceId: frame[field],
        });
      }
    }
    return JSON.stringify(frame);
  }

  close(code = 1000, reason = "Local workspace socket closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.pending.length = 0;
    this.pendingBytes = 0;
    this.stream?.close(code, reason);
    this.stream?.dispose();
    this.socket?.close(code, reason);
  }
}

export function remoteTerminalProxy(id: string, user: CurrentUser): WorkspaceSocketProxy | undefined {
  const reference = decodeCollaborationResourceReference(id);
  if (!reference) return undefined;
  if (reference.resourceKind !== "terminal") throw new DomainError("collaboration_reference_invalid", "A terminal reference is required.");
  const runtime = runWithCurrentUser(user, () => workspaceConnections.require(reference.connectionId));
  return new WorkspaceSocketProxy(runtime, {
    kind: "terminal", path: `/api/terminal?terminalSessionId=${encodeURIComponent(reference.resourceId)}`,
  });
}

export function remotePreviewProxy(raw: string | Buffer, user: CurrentUser): {
  proxy: WorkspaceSocketProxy;
  hello: string;
} | undefined {
  const frame: unknown = JSON.parse(typeof raw === "string" ? raw : raw.toString());
  if (!isReadRecord(frame) || frame["type"] !== "hello" || !isReadRecord(frame["target"])) return undefined;
  const target = frame["target"];
  const reference = typeof target["reference"] === "string"
    ? decodeCollaborationResourceReference(target["reference"]) : undefined;
  if (!reference) return undefined;
  if (target["kind"] !== "workspace" || reference.resourceKind !== "workspace") {
    throw new DomainError("collaboration_operation_forbidden", "Only a shared workspace can host this preview.");
  }
  const runtime = runWithCurrentUser(user, () => workspaceConnections.require(reference.connectionId));
  target["reference"] = reference.resourceId;
  if (isReadRecord(frame["code"])) {
    for (const field of ["chat", "task"]) {
      const value = frame["code"][field];
      if (value === undefined) continue;
      const codeReference = typeof value === "string" ? decodeCollaborationResourceReference(value) : undefined;
      if (!codeReference || codeReference.connectionId !== reference.connectionId || codeReference.resourceKind !== field) {
        throw new DomainError("collaboration_mixed_sources", "The code preview must use the same controller.");
      }
      frame["code"][field] = codeReference.resourceId;
    }
  }
  return {
    proxy: new WorkspaceSocketProxy(runtime, {
      kind: "preview", path: "/api/previews/bridge", workspaceId: reference.resourceId,
    }),
    hello: JSON.stringify(frame),
  };
}
