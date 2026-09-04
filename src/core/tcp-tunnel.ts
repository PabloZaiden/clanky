import { EventEmitter } from "node:events";
import net from "node:net";
import type { ExecutionHostBinding } from "@/shared/execution-host";
import {
  MESH_TCP_TUNNEL_CAPABILITY,
  MESH_TCP_TUNNEL_MAX_FRAME_BYTES,
  MESH_TCP_TUNNEL_OPEN_TIMEOUT_MS,
  MESH_TCP_TUNNEL_PROTOCOL_VERSION,
  MESH_TCP_TUNNEL_REQUEST_TIMEOUT_MS,
  MESH_TCP_TUNNEL_SESSION_TTL_MS,
} from "@/shared/mesh-tcp-tunnel";
import type { MeshTcpTunnelSessionRequest } from "@/contracts/schemas/mesh-tcp-tunnel";
import { getMeshLinkForLocalUser, getMeshNode, listMeshLinkMembers } from "../persistence/mesh";
import {
  ensureLocalMeshNodeIdentity,
  signMeshPayload,
} from "../persistence/mesh-node-identity";
import { decryptMeshPayload } from "./mesh-payload-crypto";
import { buildMeshTcpTunnelSigningPayload } from "./mesh-tcp-tunnel-protocol";
import { resolveMeshRoute } from "./mesh-transport-config";
import { executionHostService } from "./execution-host-service";
import { requireCurrentUserId } from "./user-context";
import { DomainError } from "./domain-error";

export interface TcpTunnel {
  readonly destroyed: boolean;
  write(data: string | Uint8Array): void;
  destroy(): void;
  on(event: "data", listener: (data: Uint8Array) => void): this;
  once(event: "close", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

class DirectTcpTunnel extends EventEmitter implements TcpTunnel {
  constructor(private readonly socket: net.Socket) {
    super();
    socket.on("data", (data) => this.emit("data", data));
    socket.once("close", () => this.emit("close"));
    socket.once("error", (error) => this.emit("error", error));
  }

  get destroyed(): boolean {
    return this.socket.destroyed;
  }

  write(data: string | Uint8Array): void {
    this.socket.write(data);
  }

  destroy(): void {
    this.socket.destroy();
  }
}

class MeshTcpTunnel extends EventEmitter implements TcpTunnel {
  private socket: WebSocket | null = null;
  private closed = false;

  constructor(
    private readonly binding: ExecutionHostBinding,
    private readonly remoteHost: "127.0.0.1",
    private readonly remotePort: number,
  ) {
    super();
  }

  get destroyed(): boolean {
    return this.closed;
  }

  async connect(): Promise<void> {
    const host = this.binding.host;
    if (host.kind !== "mesh") {
      throw new DomainError("mesh_tunnel_target_invalid", "A Mesh host is required.");
    }
    executionHostService.validateBinding(this.binding);
    const userId = requireCurrentUserId();
    const [identity, link, node] = await Promise.all([
      ensureLocalMeshNodeIdentity(),
      getMeshLinkForLocalUser(userId),
      getMeshNode(host.nodeId),
    ]);
    if (!link || link.status !== "active" || !node) {
      throw new DomainError("mesh_tunnel_target_unavailable", "The Mesh tunnel target is unavailable.");
    }
    if (!identity.encryptionPublicKey) {
      throw new DomainError(
        "mesh_tunnel_identity_invalid",
        "The local Mesh identity has no encryption key.",
      );
    }
    const member = (await listMeshLinkMembers(link.linkId))
      .find((candidate) => candidate.nodeId === host.nodeId && candidate.status === "active");
    const endpoint = member?.endpoint ?? node.endpoint;
    if (!endpoint) {
      throw new DomainError("mesh_tunnel_target_unavailable", "The Mesh tunnel target has no endpoint.");
    }
    const expiresAt = new Date(Date.now() + MESH_TCP_TUNNEL_SESSION_TTL_MS).toISOString();
    const unsigned: Omit<MeshTcpTunnelSessionRequest, "signature"> = {
      protocolVersion: MESH_TCP_TUNNEL_PROTOCOL_VERSION,
      capability: MESH_TCP_TUNNEL_CAPABILITY,
      requestId: crypto.randomUUID(),
      linkId: link.linkId,
      callerNodeId: identity.nodeId,
      callerPublicKey: identity.publicKey,
      callerFingerprint: identity.fingerprint,
      callerEncryptionPublicKey: identity.encryptionPublicKey,
      targetNodeId: host.nodeId,
      remoteHost: this.remoteHost,
      remotePort: this.remotePort,
      nonce: crypto.randomUUID(),
      expiresAt,
    };
    const request: MeshTcpTunnelSessionRequest = {
      ...unsigned,
      signature: await signMeshPayload(buildMeshTcpTunnelSigningPayload(unsigned)),
    };
    const response = await this.post(
      resolveMeshRoute(endpoint, "api/mesh/internal/tcp-tunnel/session"),
      request,
    );
    const decrypted = await decryptMeshPayload(response.encryptedPayload);
    const token = typeof decrypted === "object" && decrypted
      ? (decrypted as Record<string, unknown>)["sessionToken"]
      : null;
    if (typeof token !== "string") {
      throw new DomainError("mesh_tunnel_response_invalid", "The Mesh tunnel token is invalid.");
    }
    const BunWebSocket = WebSocket as unknown as {
      new (
        url: string,
        options: { headers: Record<string, string> },
      ): WebSocket;
    };
    const socket = new BunWebSocket(
      resolveMeshRoute(endpoint, "api/mesh/internal/tcp-tunnel").replace(/^http/, "ws"),
      {
        headers: {
          "x-clanky-mesh-session-id": response.sessionId,
          "x-clanky-mesh-session-token": token,
        },
      },
    );
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const bytes = typeof event.data === "string"
        ? Buffer.from(event.data)
        : new Uint8Array(event.data as ArrayBuffer);
      this.emit("data", bytes);
    });
    socket.addEventListener("close", () => {
      this.closed = true;
      this.emit("close");
    });
    socket.addEventListener("error", () => {
      this.emit("error", new Error("Mesh TCP tunnel failed."));
    });
    try {
      await this.waitForOpen(socket);
    } catch (error) {
      this.socket = null;
      socket.close();
      throw error;
    }
  }

  write(data: string | Uint8Array): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new DomainError("mesh_tunnel_not_open", "The Mesh TCP tunnel is not open.");
    }
    if (Buffer.byteLength(data) > MESH_TCP_TUNNEL_MAX_FRAME_BYTES) {
      throw new DomainError("mesh_tunnel_frame_too_large", "The TCP tunnel frame is too large.");
    }
    this.socket.send(typeof data === "string" ? data : Buffer.from(data));
  }

  destroy(): void {
    this.closed = true;
    this.socket?.close(1000, "TCP tunnel closed");
    this.socket = null;
  }

  private async post(
    url: string,
    body: MeshTcpTunnelSessionRequest,
  ): Promise<{ sessionId: string; encryptedPayload: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MESH_TCP_TUNNEL_REQUEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-clanky-mesh-node-id": body.callerNodeId,
          "x-clanky-mesh-request-id": body.requestId,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok || typeof payload["sessionId"] !== "string") {
        throw new DomainError(
          typeof payload["error"] === "string" ? payload["error"] : "mesh_tunnel_session_failed",
          typeof payload["message"] === "string" ? payload["message"] : "Mesh tunnel setup failed.",
        );
      }
      return {
        sessionId: payload["sessionId"],
        encryptedPayload: payload["encryptedPayload"],
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async waitForOpen(socket: WebSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new DomainError("mesh_tunnel_open_timeout", "Timed out opening the Mesh TCP tunnel."));
      }, MESH_TCP_TUNNEL_OPEN_TIMEOUT_MS);
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
      };
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new DomainError("mesh_tunnel_open_failed", "Failed to open the Mesh TCP tunnel."));
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
    });
  }
}

export async function openTcpTunnel(options: {
  binding: ExecutionHostBinding;
  remoteHost: "127.0.0.1";
  remotePort: number;
}): Promise<TcpTunnel> {
  executionHostService.validateBinding(options.binding);
  if (options.binding.host.kind === "ssh") {
    throw new DomainError(
      "ssh_tunnel_requires_credentials",
      "SSH tunnel setup requires adapter credentials.",
    );
  }
  if (options.binding.host.kind === "mesh") {
    const tunnel = new MeshTcpTunnel(
      options.binding,
      options.remoteHost,
      options.remotePort,
    );
    await tunnel.connect();
    return tunnel;
  }
  return new DirectTcpTunnel(net.createConnection({
    host: options.remoteHost,
    port: options.remotePort,
  }));
}

export function openForwardedTcpTunnel(localPort: number): TcpTunnel {
  return new DirectTcpTunnel(net.createConnection({
    host: "127.0.0.1",
    port: localPort,
  }));
}
