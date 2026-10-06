/**
 * An authenticated peer at the real HTTP boundary. The owned process's
 * generated identity supplies credentials only; assertions never inspect
 * persistence, private gateway state or Backend doubles.
 */
import { sign } from "node:crypto";
import { join } from "node:path";
import { buildMeshExecutionSessionSigningPayload } from "../../src/core/mesh-protocol";
import { encryptMeshPayload, decryptMeshPayloadWithKey } from "../../src/core/mesh-payload-crypto";
import type { MeshHarnessOperation } from "../../src/contracts/schemas/mesh-harness";
import { MESH_PROTOCOL_VERSION } from "../../src/shared/mesh-protocol";
import type { ManagedMeshNode } from "./mesh-process-cluster";
import type { AgentSession } from "../../src/backends/types";

interface PeerIdentity {
  nodeId: string; publicKey: string; privateKey: string; fingerprint: string;
  encryptionPublicKey: string; encryptionPrivateKey: string;
}
export async function createNativeMeshPeer(controller: ManagedMeshNode, worker: ManagedMeshNode): Promise<{
  open(options: { workspaceId: string; ownerId: string; ttlMs?: number }): Promise<NativeMeshPeerLease>;
}> {
  const caller = await Bun.file(join(controller.dataDir, "mesh", "node-identity.json")).json() as PeerIdentity;
  const target = await Bun.file(join(worker.dataDir, "mesh", "node-identity.json")).json() as PeerIdentity;
  return {
    async open(options): Promise<NativeMeshPeerLease> {
      const unsigned = {
        protocolVersion: MESH_PROTOCOL_VERSION, requestId: crypto.randomUUID(),
        callerNodeId: caller.nodeId, callerPublicKey: caller.publicKey, callerFingerprint: caller.fingerprint,
        callerEncryptionPublicKey: caller.encryptionPublicKey, targetNodeId: target.nodeId,
        workspaceId: options.workspaceId, directory: worker.dataDir, provider: "codex" as const,
        channel: "harness" as const, adapter: "codex" as const, ownerId: options.ownerId,
        nonce: crypto.randomUUID(), expiresAt: new Date(Date.now() + (options.ttlMs ?? 60_000)).toISOString(),
      };
      const response = await fetch(`${worker.baseUrl}/api/mesh/internal/execution/session`, {
        method: "POST", headers: {
          "content-type": "application/json", "x-clanky-mesh-node-id": caller.nodeId,
          "x-clanky-mesh-request-id": unsigned.requestId,
        }, tls: worker.tlsCertificate ? { ca: worker.tlsCertificate } : undefined,
        body: JSON.stringify({
          ...unsigned, signature: sign(null, Buffer.from(buildMeshExecutionSessionSigningPayload(unsigned)), caller.privateKey).toString("base64url"),
        }),
      });
      const body = await response.json() as { error?: string; sessionId: string; expiresAt: string; encryptedPayload: unknown };
      if (!response.ok) throw new Error(`Peer lease failed: ${response.status} ${body.error ?? "unknown"}`);
      const credentials = decryptMeshPayloadWithKey(body.encryptedPayload, caller.encryptionPrivateKey) as { sessionToken: string };
      return {
        id: body.sessionId, expiresAt: body.expiresAt,
        async rpc<T>(operation: MeshHarnessOperation, options?: { requestId: string }): Promise<{ status: number; body: T }> {
          const requestId = options?.requestId ?? crypto.randomUUID();
          const result = await fetch(`${worker.baseUrl}/api/mesh/internal/harness/rpc`, {
            method: "POST", tls: worker.tlsCertificate ? { ca: worker.tlsCertificate } : undefined,
            headers: { "content-type": "application/json", "x-clanky-mesh-session-id": body.sessionId, "x-clanky-mesh-request-id": requestId },
            body: JSON.stringify({ protocolVersion: MESH_PROTOCOL_VERSION, sessionId: body.sessionId, sessionToken: credentials.sessionToken,
              requestId, encryptedPayload: encryptMeshPayload(operation, target.encryptionPublicKey),
            }),
          });
          const value = await result.json() as { encryptedPayload?: unknown };
          return { status: result.status, body: (result.ok ? decryptMeshPayloadWithKey(value.encryptedPayload, caller.encryptionPrivateKey) : value) as T };
        },
        async close(): Promise<void> {
          const requestId = crypto.randomUUID();
          const result = await fetch(`${worker.baseUrl}/api/mesh/internal/execution/session`, {
            method: "DELETE", tls: worker.tlsCertificate ? { ca: worker.tlsCertificate } : undefined,
            headers: { "content-type": "application/json", "x-clanky-mesh-session-id": body.sessionId, "x-clanky-mesh-request-id": requestId },
            body: JSON.stringify({ protocolVersion: MESH_PROTOCOL_VERSION, sessionId: body.sessionId, sessionToken: credentials.sessionToken, requestId }),
          });
          await result.body?.cancel();
          if (!result.ok && result.status !== 401) throw new Error(`Peer release failed: ${result.status}`);
        },
        async observe(conversationId: string): Promise<Response> {
          const requestId = crypto.randomUUID();
          return await fetch(`${worker.baseUrl}/api/mesh/internal/harness/events`, {
            method: "POST", tls: worker.tlsCertificate ? { ca: worker.tlsCertificate } : undefined,
            headers: { "content-type": "application/json", "x-clanky-mesh-session-id": body.sessionId, "x-clanky-mesh-request-id": requestId },
            body: JSON.stringify({ protocolVersion: MESH_PROTOCOL_VERSION, sessionId: body.sessionId, sessionToken: credentials.sessionToken,
              requestId, conversationId, encryptedPayload: null,
            }),
          });
        },
      };
    },
  };
}

export interface NativeMeshPeerLease {
  id: string; expiresAt: string;
  rpc<T = AgentSession>(operation: MeshHarnessOperation, options?: { requestId: string }): Promise<{ status: number; body: T }>;
  close(): Promise<void>;
  observe(conversationId: string): Promise<Response>;
}
