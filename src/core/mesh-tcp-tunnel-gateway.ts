import { randomBytes } from "node:crypto";
import net from "node:net";
import type { MeshTcpTunnelSessionRequest } from "@/contracts/schemas/mesh-tcp-tunnel";
import {
  MESH_TCP_TUNNEL_CAPABILITY,
  MESH_TCP_TUNNEL_MAX_FRAME_BYTES,
  MESH_TCP_TUNNEL_PROTOCOL_VERSION,
  MESH_TCP_TUNNEL_SESSION_TTL_MS,
} from "@/shared/mesh-tcp-tunnel";
import { getMeshLinkById, getMeshNode, listMeshLinkMembers } from "../persistence/mesh";
import {
  ensureLocalMeshNodeIdentity,
  requireLocalMeshExecutionCapability,
  verifyMeshPayloadSignature,
} from "../persistence/mesh-node-identity";
import { DomainError } from "./domain-error";
import { meshInboundResourceRegistry } from "./mesh-inbound-resource-registry";
import { requireTrustedMeshPeer } from "./mesh-peer-auth";
import { buildMeshTcpTunnelSigningPayload } from "./mesh-tcp-tunnel-protocol";

const MAX_TUNNELS = 32;
const MAX_USED_NONCES = 256;

export interface MeshTcpTunnelSocket {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

interface TunnelLease {
  sessionId: string;
  sessionToken: string;
  linkId: string;
  callerNodeId: string;
  remotePort: number;
  expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout>;
}

interface TunnelRelay {
  webSocket: MeshTcpTunnelSocket;
  socket: net.Socket;
  validationTimer: ReturnType<typeof setInterval>;
  unregister: () => void;
}

export class MeshTcpTunnelGateway {
  private readonly leases = new Map<string, TunnelLease>();
  private readonly relays = new Map<string, TunnelRelay>();
  private readonly usedNonces = new Map<string, number>();

  async createSession(request: MeshTcpTunnelSessionRequest): Promise<{
    protocolVersion: typeof MESH_TCP_TUNNEL_PROTOCOL_VERSION;
    capability: typeof MESH_TCP_TUNNEL_CAPABILITY;
    sessionId: string;
    sessionToken: string;
    expiresAt: string;
  }> {
    this.pruneExpired();
    await requireLocalMeshExecutionCapability("tcpTunnel");
    if (request.capability !== MESH_TCP_TUNNEL_CAPABILITY) {
      throw new DomainError("mesh_tunnel_capability_mismatch", "The TCP tunnel capability does not match.");
    }
    const expiresAtRequest = Date.parse(request.expiresAt);
    if (
      !Number.isFinite(expiresAtRequest)
      || expiresAtRequest <= Date.now()
      || expiresAtRequest > Date.now() + MESH_TCP_TUNNEL_SESSION_TTL_MS
    ) {
      throw new DomainError("mesh_tunnel_session_expired", "The TCP tunnel request has expired.");
    }
    if (this.usedNonces.has(request.nonce)) {
      throw new DomainError("mesh_tunnel_replay", "The TCP tunnel request was already used.");
    }
    if (this.leases.size >= MAX_TUNNELS || this.usedNonces.size >= MAX_USED_NONCES) {
      throw new DomainError("mesh_tunnel_capacity", "The Mesh TCP tunnel capacity was reached.");
    }
    const { signature, ...unsigned } = request;
    if (!verifyMeshPayloadSignature(
      buildMeshTcpTunnelSigningPayload(unsigned),
      signature,
      request.callerPublicKey,
    )) {
      throw new DomainError("mesh_peer_signature_invalid", "The TCP tunnel signature is invalid.");
    }
    const identity = await ensureLocalMeshNodeIdentity();
    if (request.targetNodeId !== identity.nodeId) {
      throw new DomainError("mesh_tunnel_target_invalid", "The TCP tunnel targets another node.");
    }
    const { link } = await requireTrustedMeshPeer({
      linkId: request.linkId,
      nodeId: request.callerNodeId,
      publicKey: request.callerPublicKey,
      fingerprint: request.callerFingerprint,
      encryptionPublicKey: request.callerEncryptionPublicKey,
      requireEncryptionKey: true,
      requireActiveNode: true,
      requireActiveMember: true,
      context: "TCP tunnel caller",
    });
    if (link.status !== "active") {
      throw new DomainError("mesh_link_revoked", "The Mesh TCP tunnel link is not active.");
    }
    const sessionId = crypto.randomUUID();
    const expiresAt = Math.min(expiresAtRequest, Date.now() + MESH_TCP_TUNNEL_SESSION_TTL_MS);
    const expiryTimer = setTimeout(() => {
      void this.close(sessionId, 1000, "Mesh TCP tunnel expired");
    }, Math.max(1, expiresAt - Date.now()));
    expiryTimer.unref?.();
    const lease: TunnelLease = {
      sessionId,
      sessionToken: randomBytes(32).toString("base64url"),
      linkId: request.linkId,
      callerNodeId: request.callerNodeId,
      remotePort: request.remotePort,
      expiresAt,
      expiryTimer,
    };
    this.leases.set(sessionId, lease);
    this.usedNonces.set(request.nonce, expiresAt);
    return {
      protocolVersion: MESH_TCP_TUNNEL_PROTOCOL_VERSION,
      capability: MESH_TCP_TUNNEL_CAPABILITY,
      sessionId,
      sessionToken: lease.sessionToken,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async authorize(sessionId: string, sessionToken: string): Promise<void> {
    await this.requireLease(sessionId, sessionToken);
  }

  async open(
    webSocket: MeshTcpTunnelSocket,
    sessionId: string,
    sessionToken: string,
  ): Promise<void> {
    const lease = await this.requireLease(sessionId, sessionToken);
    if (this.relays.has(sessionId)) {
      throw new DomainError("mesh_tunnel_session_in_use", "The TCP tunnel is already connected.");
    }
    const socket = net.createConnection({
      host: "127.0.0.1",
      port: lease.remotePort,
    });
    const validationTimer = setInterval(() => {
      void this.requireLease(sessionId, sessionToken).catch(() => {
        void this.close(sessionId, 1008, "Mesh TCP tunnel authority changed");
      });
    }, 15_000);
    validationTimer.unref?.();
    const unregister = meshInboundResourceRegistry.register({
      id: `tcp-tunnel:${sessionId}`,
      capabilities: ["tcpTunnel"],
      close: async (reason) => await this.close(sessionId, 1008, reason),
    });
    this.relays.set(sessionId, { webSocket, socket, validationTimer, unregister });
    socket.on("data", (data) => {
      try {
        webSocket.send(typeof data === "string" ? Buffer.from(data) : new Uint8Array(data));
      } catch {
        void this.close(sessionId, 1011, "TCP tunnel relay failed");
      }
    });
    socket.once("close", () => {
      void this.close(sessionId, 1000, "TCP connection closed");
    });
    socket.once("error", () => {
      void this.close(sessionId, 1011, "TCP connection failed");
    });
  }

  async message(
    sessionId: string,
    sessionToken: string,
    data: string | Buffer,
  ): Promise<void> {
    await this.requireLease(sessionId, sessionToken);
    const relay = this.relays.get(sessionId);
    if (!relay) {
      throw new DomainError("mesh_tunnel_not_open", "The TCP tunnel is not open.");
    }
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    if (bytes.byteLength > MESH_TCP_TUNNEL_MAX_FRAME_BYTES) {
      await this.close(sessionId, 1009, "TCP tunnel frame is too large");
      return;
    }
    relay.socket.write(bytes);
  }

  async close(sessionId: string, code = 1000, reason = "TCP tunnel closed"): Promise<void> {
    const relay = this.relays.get(sessionId);
    this.relays.delete(sessionId);
    const lease = this.leases.get(sessionId);
    this.leases.delete(sessionId);
    if (lease) {
      clearTimeout(lease.expiryTimer);
    }
    if (relay) {
      clearInterval(relay.validationTimer);
      relay.unregister();
      relay.socket.destroy();
      try {
        relay.webSocket.close(code, reason);
      } catch {
        // The peer may already have closed its socket.
      }
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.leases.keys()].map(
      async (sessionId) => await this.close(sessionId),
    ));
  }

  private async requireLease(sessionId: string, sessionToken: string): Promise<TunnelLease> {
    await requireLocalMeshExecutionCapability("tcpTunnel");
    this.pruneExpired();
    const lease = this.leases.get(sessionId);
    if (!lease || lease.sessionToken !== sessionToken || lease.expiresAt <= Date.now()) {
      throw new DomainError("mesh_tunnel_session_invalid", "The TCP tunnel session is invalid.");
    }
    const [link, node, members] = await Promise.all([
      getMeshLinkById(lease.linkId),
      getMeshNode(lease.callerNodeId),
      listMeshLinkMembers(lease.linkId),
    ]);
    const member = members.find((candidate) => candidate.nodeId === lease.callerNodeId);
    if (
      link?.status !== "active"
      || node?.status !== "active"
      || member?.status !== "active"
    ) {
      await this.close(sessionId, 1008, "Mesh TCP tunnel authority changed");
      throw new DomainError("mesh_tunnel_context_changed", "The TCP tunnel caller is no longer trusted.");
    }
    return lease;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [nonce, expiresAt] of this.usedNonces) {
      if (expiresAt <= now) {
        this.usedNonces.delete(nonce);
      }
    }
    for (const [sessionId, lease] of this.leases) {
      if (lease.expiresAt <= now) {
        void this.close(sessionId);
      }
    }
  }
}

export const meshTcpTunnelGateway = new MeshTcpTunnelGateway();
