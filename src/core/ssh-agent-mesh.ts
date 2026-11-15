import { z } from "zod";
import {
  MeshSshAgentRequestSchema, MeshSshAgentResponseSchema, SshAgentOperationSchema,
  type MeshSshAgentRequest, type SshAgentOperation,
} from "@/contracts/schemas/ssh-key-access";
import { MESH_SSH_AGENT_HEADER, MESH_SSH_AGENT_PATH, MESH_SSH_AGENT_VERSION } from "@/shared/ssh-key-access";
import { MESH_PROTOCOL_VERSION_HEADER } from "@/shared/mesh-protocol";
import type { MeshPeerRoute } from "@/shared/mesh";
import { ensureLocalMeshNodeIdentity, signMeshPayload, verifyMeshPayloadSignature } from "../persistence/mesh-node-identity";
import { getControllerGrant, listActiveWorkerRegistrations } from "../persistence/mesh";
import { listActiveUsers } from "../persistence/users";
import { getMeshRuntimeRole } from "./mesh-runtime";
import { requestMeshPeer } from "./mesh-peer-transport";
import { readMeshControlResponseJson } from "./mesh-control-client";
import { sshAgentError } from "./ssh-agent-protocol";

type ResponseEnvelope = z.infer<typeof MeshSshAgentResponseSchema>;
const recentRequests = new Map<string, number>();
function requestSigningPayload(value: Omit<MeshSshAgentRequest, "signature">): string {
  return JSON.stringify(["clanky-mesh-ssh-agent-request-v1", value.protocolVersion, value.sshAgent,
    value.senderNodeId, value.recipientNodeId, value.requestId, value.issuedAt, value.operation]);
}
function responseSigningPayload(value: Omit<ResponseEnvelope, "signature">): string {
  return JSON.stringify(["clanky-mesh-ssh-agent-response-v1", value.protocolVersion, value.sshAgent,
    value.senderNodeId, value.recipientNodeId, value.requestId, value.payload]);
}
export interface SshMeshPeer {
  nodeId: string;
  publicKey: string;
  route: MeshPeerRoute;
}
export async function callSshMeshPeer(peer: SshMeshPeer, operation: SshAgentOperation, negotiate = true): Promise<unknown> {
  if (negotiate && operation.kind !== "capability") {
    const capability = await callSshMeshPeer(peer, { kind: "capability" }, false);
    if (!capability || typeof capability !== "object" || !("sshAgent" in capability) || capability.sshAgent !== MESH_SSH_AGENT_VERSION) {
      throw sshAgentError("capability_unavailable", "Update the Mesh peers and relay to support scoped SSH-agent access.");
    }
  }
  const identity = await ensureLocalMeshNodeIdentity();
  const unsigned: Omit<MeshSshAgentRequest, "signature"> = {
    protocolVersion: 7, sshAgent: MESH_SSH_AGENT_VERSION, senderNodeId: identity.nodeId,
    recipientNodeId: peer.nodeId, requestId: crypto.randomUUID(), issuedAt: Date.now(), operation: SshAgentOperationSchema.parse(operation),
  };
  const body: MeshSshAgentRequest = { ...unsigned, signature: await signMeshPayload(requestSigningPayload(unsigned)) };
  const signal = AbortSignal.timeout(10_000);
  let response: Response;
  try {
    response = await requestMeshPeer(peer.route, MESH_SSH_AGENT_PATH.slice(1), {
      method: "POST", signal,
      headers: {
        "content-type": "application/json",
        [MESH_PROTOCOL_VERSION_HEADER]: "7",
        [MESH_SSH_AGENT_HEADER]: String(MESH_SSH_AGENT_VERSION),
        "x-clanky-mesh-node-id": identity.nodeId,
        "x-clanky-mesh-request-id": body.requestId,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw sshAgentError("source_unavailable", `The authenticated Mesh SSH-agent route is unavailable${error instanceof Error && error.name === "TimeoutError" ? " (timed out)" : ""}.`);
  }
  if (!response.ok) {
    const failure: unknown = await readMeshControlResponseJson(response, { signal, maxBytes: 4096 }).catch(() => undefined);
    const messages: Record<string, string> = {
      ssh_agent_key_revoked: "The workspace SSH-key grant is revoked.",
      ssh_agent_key_unavailable: "The selected SSH key is not available in its custodian agent.",
      ssh_agent_source_unavailable: "The selected SSH-agent source is disconnected or unavailable.",
      ssh_agent_access_denied: "The Mesh SSH-agent identity, registration or workspace binding is no longer authorized.",
      ssh_agent_capability_unavailable: "Update the Mesh peers and relay to support scoped SSH-agent access.",
      ssh_agent_operation_forbidden: "The SSH-agent request is not permitted.",
      ssh_agent_protocol_invalid: "The Mesh SSH-agent request or response is invalid.",
    };
    if (failure && typeof failure === "object" && "error" in failure && typeof failure.error === "string" && messages[failure.error]) {
      throw sshAgentError(failure.error.slice("ssh_agent_".length), messages[failure.error]!);
    }
    throw sshAgentError(response.status === 404 ? "capability_unavailable" : response.status === 403 ? "access_denied" : "source_unavailable",
      `The Mesh SSH-agent request was refused (HTTP ${response.status}).`);
  }
  const parsed = MeshSshAgentResponseSchema.safeParse(await readMeshControlResponseJson(response, { signal, maxBytes: 768 * 1024 }));
  if (!parsed.success) throw sshAgentError("protocol_invalid", "The Mesh SSH-agent response is invalid.");
  const { signature, ...reply } = parsed.data;
  if (reply.senderNodeId !== peer.nodeId || reply.recipientNodeId !== identity.nodeId || reply.requestId !== body.requestId
    || !verifyMeshPayloadSignature(responseSigningPayload(reply), signature, peer.publicKey)) {
    throw sshAgentError("access_denied", "The Mesh SSH-agent response identity or signature is invalid.");
  }
  return reply.payload;
}
export async function verifySshMeshRequest(body: MeshSshAgentRequest): Promise<string> {
  const identity = await ensureLocalMeshNodeIdentity();
  const now = Date.now();
  if (body.recipientNodeId !== identity.nodeId || body.issuedAt < now - 30_000 || body.issuedAt > now + 5000) {
    throw sshAgentError("access_denied", "The Mesh SSH-agent request target or lifetime is invalid.");
  }
  let publicKeys: string[];
  if (getMeshRuntimeRole() === "worker") {
    const grant = await getControllerGrant(body.senderNodeId);
    publicKeys = grant?.grantStatus === "active" ? [grant.controllerPublicKey] : [];
  } else {
    const registrations = (await Promise.all(listActiveUsers().map((user) => listActiveWorkerRegistrations(user.id)))).flat();
    publicKeys = registrations.filter((worker) => worker.workerNodeId === body.senderNodeId).map((worker) => worker.workerPublicKey);
  }
  const { signature, ...unsigned } = body;
  const verifiedPublicKey = publicKeys.find((key) => verifyMeshPayloadSignature(requestSigningPayload(unsigned), signature, key));
  if (!verifiedPublicKey) {
    throw sshAgentError("access_denied", "The Mesh SSH-agent sender has no matching active signed grant.");
  }
  for (const [key, expires] of recentRequests) if (expires <= now) recentRequests.delete(key);
  const replayKey = `${body.senderNodeId}:${body.requestId}`;
  if (recentRequests.has(replayKey) || recentRequests.size >= 8192) {
    throw sshAgentError("access_denied", "The Mesh SSH-agent request was replayed or admission is full.");
  }
  recentRequests.set(replayKey, now + 35_000);
  return verifiedPublicKey;
}
export async function signSshMeshResponse(request: MeshSshAgentRequest, payload: unknown): Promise<ResponseEnvelope> {
  const reply: Omit<ResponseEnvelope, "signature"> = {
    protocolVersion: 7, sshAgent: MESH_SSH_AGENT_VERSION, senderNodeId: request.recipientNodeId,
    recipientNodeId: request.senderNodeId, requestId: request.requestId, payload,
  };
  return { ...reply, signature: await signMeshPayload(responseSigningPayload(reply)) };
}
export async function parseSshMeshRequest(request: Request): Promise<MeshSshAgentRequest> {
  if (request.headers.get(MESH_SSH_AGENT_HEADER) !== String(MESH_SSH_AGENT_VERSION)) {
    throw sshAgentError("capability_unavailable", "Scoped SSH-agent access requires explicit capability negotiation.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw sshAgentError("protocol_invalid", "The Mesh SSH-agent request is empty.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 768 * 1024) throw sshAgentError("protocol_invalid", "The Mesh SSH-agent request exceeds its size bound.");
      chunks.push(value);
    }
    return MeshSshAgentRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
