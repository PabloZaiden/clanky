import { EventEmitter } from "node:events";
import net from "node:net";
import { createLogger } from "@pablozaiden/webapp/server";
import type { ExecutionHostBinding } from "@/shared/execution-host";
import type { MeshWorkerRegistration } from "@/shared/mesh";
import {
  MESH_TCP_TUNNEL_CAPABILITY,
  MESH_TCP_TUNNEL_MAX_FRAME_BYTES,
  MESH_TCP_TUNNEL_OPEN_TIMEOUT_MS,
  MESH_TCP_TUNNEL_LEGACY_PROTOCOL_VERSION,
  MESH_TCP_TUNNEL_REQUEST_TIMEOUT_MS,
  MESH_TCP_TUNNEL_SESSION_REQUEST_TTL_MS,
} from "@/shared/mesh-tcp-tunnel";
import { MESH_PROTOCOL_VERSION } from "@/shared/mesh-protocol";
import type { MeshTcpTunnelSessionRequest } from "@/contracts/schemas/mesh-tcp-tunnel";
import {
  getWorkerRegistration,
  updateWorkerNegotiatedProtocolVersion,
} from "../persistence/mesh";
import {
  ensureLocalMeshNodeIdentity,
  signMeshPayload,
} from "../persistence/mesh-node-identity";
import { decryptMeshPayload } from "./mesh-payload-crypto";
import { buildMeshTcpTunnelSigningPayload } from "./mesh-tcp-tunnel-protocol";
import {
  openMeshPeerSocket,
  requestMeshPeer,
  type MeshDuplexSocket,
} from "./mesh-peer-transport";
import { executionHostService } from "./execution-host-service";
import { requireCurrentUserId } from "../context/user-context";
import { DomainError } from "../domain/domain-error";
import { isMeshProtocolCompatibilityError } from "./mesh-protocol-version";

const log = createLogger("core:tcp-tunnel");

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
  private socket: MeshDuplexSocket | null = null;
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
    const [identity, registration] = await Promise.all([
      ensureLocalMeshNodeIdentity(),
      getWorkerRegistration(host.nodeId, userId),
    ]);
    if (!registration || registration.grantStatus !== "active") {
      throw new DomainError("mesh_tunnel_target_unavailable", "The Mesh tunnel target is unavailable.");
    }
    if (!identity.encryptionPublicKey) {
      throw new DomainError(
        "mesh_tunnel_identity_invalid",
        "The local Mesh identity has no encryption key.",
      );
    }
    const route = registration.route;
    let protocolVersion:
      | typeof MESH_PROTOCOL_VERSION
      | typeof MESH_TCP_TUNNEL_LEGACY_PROTOCOL_VERSION =
      registration.workerNegotiatedProtocolVersion
      === MESH_PROTOCOL_VERSION
      ? MESH_PROTOCOL_VERSION
      : MESH_TCP_TUNNEL_LEGACY_PROTOCOL_VERSION;
    const expiresAt = new Date(
      Date.now() + MESH_TCP_TUNNEL_SESSION_REQUEST_TTL_MS,
    ).toISOString();
    const buildRequest = async (): Promise<MeshTcpTunnelSessionRequest> => {
      const unsigned: Omit<MeshTcpTunnelSessionRequest, "signature"> = {
        protocolVersion,
        capability: MESH_TCP_TUNNEL_CAPABILITY,
        requestId: crypto.randomUUID(),
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
      return {
        ...unsigned,
        signature: await signMeshPayload(buildMeshTcpTunnelSigningPayload(unsigned)),
      };
    };
    let request = await buildRequest();
    let response: {
      protocolVersion:
        | typeof MESH_PROTOCOL_VERSION
        | typeof MESH_TCP_TUNNEL_LEGACY_PROTOCOL_VERSION;
      sessionId: string;
      encryptedPayload: unknown;
    };
    try {
      response = await this.post(
        route,
        "api/mesh/internal/tcp-tunnel/session",
        request,
      );
    } catch (error) {
      if (
        protocolVersion !== MESH_PROTOCOL_VERSION
        || !isMeshProtocolCompatibilityError(error)
      ) {
        throw error;
      }
      protocolVersion = MESH_TCP_TUNNEL_LEGACY_PROTOCOL_VERSION;
      try {
        await updateWorkerNegotiatedProtocolVersion({
          workerNodeId: host.nodeId,
          localUserId: userId,
          negotiatedProtocolVersion: protocolVersion,
          preferredProtocolVersion: protocolVersion,
        });
      } catch (updateError) {
        log.warn("Mesh TCP tunnel protocol downgrade could not be persisted", {
          workerNodeId: host.nodeId,
          error: String(updateError),
        });
      }
      request = await buildRequest();
      response = await this.post(
        route,
        "api/mesh/internal/tcp-tunnel/session",
        request,
      );
    }
    const decrypted = await decryptMeshPayload(response.encryptedPayload);
    const token = typeof decrypted === "object" && decrypted
      ? (decrypted as Record<string, unknown>)["sessionToken"]
      : null;
    if (typeof token !== "string") {
      throw new DomainError("mesh_tunnel_response_invalid", "The Mesh tunnel token is invalid.");
    }
    const socket = openMeshPeerSocket(
      route,
      "api/mesh/internal/tcp-tunnel",
      {
        "x-clanky-mesh-session-id": response.sessionId,
        "x-clanky-mesh-session-token": token,
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
      if (this.listenerCount("error") > 0) {
        this.emit("error", new Error("Mesh TCP tunnel failed."));
      }
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
    route: MeshWorkerRegistration["route"],
    path: string,
    body: MeshTcpTunnelSessionRequest,
  ): Promise<{
    protocolVersion: typeof MESH_PROTOCOL_VERSION
      | typeof MESH_TCP_TUNNEL_LEGACY_PROTOCOL_VERSION;
    sessionId: string;
    encryptedPayload: unknown;
  }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MESH_TCP_TUNNEL_REQUEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await requestMeshPeer(route, path, {
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
          { details: { status: response.status } },
        );
      }
      if (payload["protocolVersion"] !== body.protocolVersion) {
        throw new DomainError(
          "mesh_tunnel_protocol_mismatch",
          "The Mesh TCP tunnel peer uses a different protocol generation.",
        );
      }
      return {
        protocolVersion: body.protocolVersion,
        sessionId: payload["sessionId"],
        encryptedPayload: payload["encryptedPayload"],
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async waitForOpen(socket: MeshDuplexSocket): Promise<void> {
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
  executionHostService.requireBindingCapability(
    options.binding,
    "tcpTunnel",
  );
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
