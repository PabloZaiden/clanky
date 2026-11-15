import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ExecutionHostRef } from "@/shared/execution-host";
import type { MeshSshAgentRequest } from "@/contracts/schemas/ssh-key-access";
import { MESH_SSH_AGENT_VERSION, type SshAgentIdentity, type SshKeySource, type SshPublicKey, type WorkspaceSshKeyAccess } from "@/shared/ssh-key-access";
import { getAccountStore, getDataDir } from "../persistence/database";
import { getWorkspace } from "../persistence/workspaces";
import { listActiveUsers, toCurrentUser } from "../persistence/users";
import { getWorkerRegistration, getWorkerRegistrationByWorkspace, getControllerGrant, listActiveControllerGrants, listActiveWorkerRegistrations } from "../persistence/mesh";
import { ensureLocalMeshNodeIdentity } from "../persistence/mesh-node-identity";
import {
  listSshKeySources, saveSshKeySource, deleteSshKeySource, listSshPublicKeys, saveSshPublicKey,
  listSshKeyGrants, setSshKeyGrant, transferSshKeyGrants, deleteSshScopeGrants, replaceProvisioningSshKeyGrants, type StoredSshKeySource,
} from "../persistence/ssh-key-access";
import { runWithAuthenticatedUser } from "../context/user-context";
import { executionHostService } from "./execution-host-service";
import { getMeshRuntimeRole } from "./mesh-runtime";
import { callSshMeshPeer, type SshMeshPeer } from "./ssh-agent-mesh";
import {
  decodeSshBase64, listSourceAgentIdentities, parseSshAgentRequest, signWithSourceAgent, sshAgentError,
  sshIdentity, sshIdentityResponse,
} from "./ssh-agent-protocol";
import { openScopedSshAgentSocket, type ScopedSshAgentSocket } from "./ssh-agent-socket";
import { scopedSshAgentEnvironment, workspaceSshAgentSocketPath } from "./ssh-agent-environment";

const sourceSocket = process.env["CLANKY_WORKSPACE_SSH_AGENT"] === "1"
  ? undefined : process.env["CLANKY_SSH_AGENT_SOURCE_SOCK"] ?? process.env["SSH_AUTH_SOCK"];
const IdentitySchema = z.object({ publicKey: z.string().max(24 * 1024), fingerprint: z.string().max(128), comment: z.string().max(1024) }).strict();
const sockets = new Map<string, ScopedSshAgentSocket>();
const openingSockets = new Map<string, Promise<ScopedSshAgentSocket>>();
interface ProvisioningLease {
  id: string;
  userId: string;
  scopeId: string;
  environmentId: string;
  operationId: string;
  host: ExecutionHostRef;
  hostFingerprint: string;
  keyIds: ReadonlySet<string>;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  closeRemote?: () => Promise<void>;
  assertActive: () => void | Promise<void>;
}
const leases = new Map<string, ProvisioningLease>();
const remoteSocketTimers = new Map<string, ReturnType<typeof setTimeout>>();
const remoteSocketOwners = new Map<string, string>();

function requireOwner(userId: string) {
  const owner = getAccountStore().getUserById(userId);
  if (!owner || owner.disabledAt) throw sshAgentError("access_denied", "The SSH-key owner is unavailable.");
  return toCurrentUser(owner);
}
async function ownedWorkspace(userId: string, workspaceId: string) {
  const owner = requireOwner(userId);
  const workspace = await runWithAuthenticatedUser(owner, () => getWorkspace(workspaceId));
  if (!workspace) throw sshAgentError("access_denied", "The workspace does not belong to this SSH-key owner.");
  return workspace;
}
function publicSource(source: StoredSshKeySource): SshKeySource {
  const { hostFingerprint: _, ...result } = source;
  return result;
}
async function hostIdentity(userId: string, host: ExecutionHostRef): Promise<{ fingerprint: string; peer?: SshMeshPeer }> {
  requireOwner(userId);
  if (host.kind === "local") {
    const local = await ensureLocalMeshNodeIdentity();
    if (host.nodeId !== local.nodeId) throw sshAgentError("access_denied", "The local SSH-agent source identity does not match.");
    return { fingerprint: local.fingerprint };
  }
  const worker = getWorkerRegistration(host.nodeId, userId);
  if (!worker || worker.grantStatus !== "active" || worker.registrationScope === "workspace") {
    throw sshAgentError("access_denied", "Select an active owner-authorized general Mesh host as the SSH-key custodian or provisioning host.");
  }
  return { fingerprint: worker.workerFingerprint, peer: { nodeId: worker.workerNodeId, publicKey: worker.workerPublicKey, route: worker.route } };
}
async function sourceIdentities(userId: string, source: StoredSshKeySource): Promise<SshAgentIdentity[]> {
  const host = await hostIdentity(userId, source.host);
  if (host.fingerprint !== source.hostFingerprint) throw sshAgentError("source_unavailable", "The registered SSH-agent custodian identity has changed.");
  const result = host.peer
    ? z.array(IdentitySchema).max(256).parse(await callSshMeshPeer(host.peer, { kind: "source-list" }))
    : await listSourceAgentIdentities(sourceSocket);
  if ((await hostIdentity(userId, source.host)).fingerprint !== source.hostFingerprint) {
    throw sshAgentError("source_unavailable", "The SSH-agent custodian was revoked during identity listing.");
  }
  return result.map((identity) => {
    const actual = sshIdentity(decodeSshBase64(identity.publicKey), identity.comment);
    if (actual.fingerprint !== identity.fingerprint) throw sshAgentError("protocol_invalid", "The source public-key fingerprint is invalid.");
    return actual;
  });
}
function requireSource(userId: string, sourceId: string): StoredSshKeySource {
  const source = listSshKeySources(userId).find((candidate) => candidate.id === sourceId);
  if (!source) throw sshAgentError("access_denied", "The SSH-key source does not belong to this owner.");
  return source;
}
async function openSocket(key: string, request: (frame: Buffer) => Promise<Buffer>): Promise<ScopedSshAgentSocket> {
  const existing = sockets.get(key);
  if (existing) return existing;
  const pending = openingSockets.get(key);
  if (pending) return await pending;
  if (sockets.size + openingSockets.size >= 128) throw sshAgentError("unavailable", "The scoped SSH-agent socket capacity is exhausted.");
  const socketDirectory = process.env["CLANKY_SSH_AGENT_SOCKET_DIR"] ?? join(getDataDir(), "ssh-agent");
  const filename = `${createHash("sha256").update(key).digest("hex").slice(0, 12)}.s`;
  const path = key === "workspace" ? workspaceSshAgentSocketPath(getDataDir(), socketDirectory) : join(socketDirectory, filename);
  const opening = openScopedSshAgentSocket(path, request)
    .then((socket) => { sockets.set(key, socket); return socket; })
    .finally(() => openingSockets.delete(key));
  openingSockets.set(key, opening);
  return await opening;
}
async function closeSocket(key: string): Promise<void> {
  const opening = openingSockets.get(key);
  if (opening) await opening.catch(() => {});
  const socket = sockets.get(key);
  sockets.delete(key);
  if (socket) await socket.close();
}
async function controllerPeer(controllerNodeId: string): Promise<SshMeshPeer> {
  const grant = await getControllerGrant(controllerNodeId);
  if (grant?.grantStatus !== "active" || !grant.controllerRoute) throw sshAgentError("access_denied", "The scoped SSH-agent controller is disconnected or revoked.");
  return { nodeId: controllerNodeId, publicKey: grant.controllerPublicKey, route: grant.controllerRoute };
}
async function workerSocket(controllerNodeId: string, leaseId?: string): Promise<ScopedSshAgentSocket> {
  if (!leaseId) {
    const controllers = await listActiveControllerGrants();
    if (controllers.length !== 1 || controllers[0]!.controllerNodeId !== controllerNodeId) {
      throw sshAgentError("access_denied", "A dedicated workspace SSH-agent requires exactly one matching active controller.");
    }
  }
  const key = leaseId ?? "workspace";
  return await openSocket(key, async (frame) => {
    parseSshAgentRequest(frame);
    const peer = await controllerPeer(controllerNodeId);
    const response = await callSshMeshPeer(peer, {
      kind: "workspace-request", ...(leaseId ? { leaseId } : {}), frame: frame.toString("base64"),
    });
    return decodeSshBase64(z.string().parse(response));
  });
}
interface WorkspaceAuthority { userId: string; scopeId: string; validate(): Promise<void>; keyIds?: ReadonlySet<string> }
async function workerAuthority(workerNodeId: string, publicKey: string, leaseId?: string): Promise<WorkspaceAuthority> {
  if (leaseId) {
    const lease = leases.get(leaseId);
    const validate = async (): Promise<void> => {
      requireOwner(lease?.userId ?? "");
      if (!lease || leases.get(leaseId) !== lease || Date.now() >= lease.expiresAt || lease.host.kind !== "mesh" || lease.host.nodeId !== workerNodeId) {
        throw sshAgentError("access_denied", "The provisioning SSH-key lease is missing, expired or bound to another host.");
      }
      const host = await hostIdentity(lease.userId, lease.host);
      if (host.fingerprint !== lease.hostFingerprint || host.peer?.publicKey !== publicKey) throw sshAgentError("access_denied", "The provisioning host binding has changed.");
      await lease.assertActive();
    };
    await validate();
    return { userId: lease!.userId, scopeId: lease!.scopeId, keyIds: lease!.keyIds, validate };
  }
  const registrations = (await Promise.all(listActiveUsers().map((user) => listActiveWorkerRegistrations(user.id)))).flat()
    .filter((worker) => worker.workerNodeId === workerNodeId && worker.workerPublicKey === publicKey && worker.registrationScope === "workspace" && worker.workspaceId);
  if (registrations.length !== 1) throw sshAgentError("access_denied", "The SSH-agent requester has no unique active dedicated-workspace binding.");
  const admitted = registrations[0]!;
  const workspaceId = admitted.workspaceId!;
  const validate = async (): Promise<void> => {
    const current = getWorkerRegistration(workerNodeId, admitted.localUserId);
    const workspace = await ownedWorkspace(admitted.localUserId, workspaceId);
    if (!current || current.grantStatus !== "active" || current.registrationScope !== "workspace" || current.workspaceId !== workspaceId
      || current.workerFingerprint !== admitted.workerFingerprint || current.workerConfigRevision !== admitted.workerConfigRevision
      || workspace.executionHostBinding.host.kind !== "mesh" || workspace.executionHostBinding.host.nodeId !== workerNodeId) {
      throw sshAgentError("access_denied", "The dedicated worker's workspace or registration binding changed.");
    }
    executionHostService.validateBinding(workspace.executionHostBinding, admitted.localUserId);
  };
  await validate();
  return { userId: admitted.localUserId, scopeId: workspaceId, validate };
}
async function scopedRequest(authority: WorkspaceAuthority, frame: Buffer): Promise<Buffer> {
  const request = parseSshAgentRequest(frame);
  await authority.validate();
  const grantedKeys = (): SshPublicKey[] => {
    requireOwner(authority.userId);
    const grants = new Set(listSshKeyGrants(authority.userId, authority.scopeId).filter((grant) => grant.enabled).map((grant) => grant.keyId));
    return listSshPublicKeys(authority.userId).filter((key) => grants.has(key.id) && (!authority.keyIds || authority.keyIds.has(key.id)));
  };
  const keys = grantedKeys();
  if (request.kind === "identities") {
    if (keys.length > 256) throw sshAgentError("protocol_invalid", "A workspace can expose at most 256 SSH-agent identities.");
    const identities: SshAgentIdentity[] = [];
    for (const sourceId of new Set(keys.map((key) => key.sourceId))) {
      const loaded = await sourceIdentities(authority.userId, requireSource(authority.userId, sourceId));
      for (const key of keys.filter((candidate) => candidate.sourceId === sourceId)) {
        const identity = loaded.find((candidate) => candidate.publicKey === key.publicKey);
        if (!identity) throw sshAgentError("key_unavailable", "A granted SSH key is not loaded in its custodian agent.");
        identities.push({ ...identity, comment: key.alias });
      }
    }
    await authority.validate();
    const stillGranted = new Set(grantedKeys().map((key) => key.publicKey));
    return sshIdentityResponse(identities.filter((identity) => stillGranted.has(identity.publicKey)));
  }
  const key = keys.find((candidate) => candidate.publicKey === request.publicKey);
  if (!key) throw sshAgentError("key_revoked", "This workspace has no active grant for the requested SSH key.");
  const source = requireSource(authority.userId, key.sourceId);
  const host = await hostIdentity(authority.userId, source.host);
  if (host.fingerprint !== source.hostFingerprint) throw sshAgentError("source_unavailable", "The SSH-key custodian identity changed.");
  const response = host.peer
    ? decodeSshBase64(z.string().parse(await callSshMeshPeer(host.peer, { ...request, kind: "source-sign" })))
    : await signWithSourceAgent(sourceSocket, request);
  const currentSource = requireSource(authority.userId, source.id);
  if ((await hostIdentity(authority.userId, currentSource.host)).fingerprint !== source.hostFingerprint) {
    throw sshAgentError("source_unavailable", "The SSH-key custodian was revoked while signing.");
  }
  await authority.validate();
  if (!grantedKeys().some((candidate) => candidate.id === key.id)) throw sshAgentError("key_revoked", "The SSH-key grant was revoked while signing.");
  return response;
}
export const sshKeyAccessService = {
  list(userId: string): { sources: SshKeySource[]; keys: SshPublicKey[] } {
    requireOwner(userId);
    return { sources: listSshKeySources(userId).map(publicSource), keys: listSshPublicKeys(userId) };
  },
  async registerSource(userId: string, input: { name: string; host: ExecutionHostRef }): Promise<SshKeySource> {
    const identity = await hostIdentity(userId, input.host);
    const source: StoredSshKeySource = { ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString(), hostFingerprint: identity.fingerprint };
    await sourceIdentities(userId, source);
    saveSshKeySource(userId, source);
    return publicSource(source);
  },
  async discover(userId: string, sourceId: string): Promise<SshAgentIdentity[]> {
    return await sourceIdentities(userId, requireSource(userId, sourceId));
  },
  async registerKey(userId: string, sourceId: string, input: { publicKey: string; alias: string }): Promise<SshPublicKey> {
    const identities = await this.discover(userId, sourceId);
    const identity = identities.find((key) => key.publicKey === input.publicKey);
    if (!identity) throw sshAgentError("key_unavailable", "Register only a public key currently loaded in the selected source agent.");
    const key: SshPublicKey = { ...identity, ...input, id: crypto.randomUUID(), sourceId, createdAt: new Date().toISOString() };
    saveSshPublicKey(userId, key);
    return listSshPublicKeys(userId).find((stored) => stored.sourceId === sourceId && stored.fingerprint === key.fingerprint)!;
  },
  removeSource(userId: string, sourceId: string): void {
    requireOwner(userId);
    requireSource(userId, sourceId);
    deleteSshKeySource(userId, sourceId);
  },
  async workspaceAccess(userId: string, workspaceId: string): Promise<WorkspaceSshKeyAccess> {
    await ownedWorkspace(userId, workspaceId);
    return { ...this.list(userId), grants: listSshKeyGrants(userId, workspaceId) };
  },
  async setGrant(userId: string, workspaceId: string, keyId: string, enabled: boolean): Promise<WorkspaceSshKeyAccess> {
    await ownedWorkspace(userId, workspaceId);
    if (!listSshPublicKeys(userId).some((key) => key.id === keyId)) throw sshAgentError("access_denied", "The selected SSH key does not belong to this owner.");
    setSshKeyGrant(userId, workspaceId, keyId, enabled);
    return await this.workspaceAccess(userId, workspaceId);
  },
  async ensureWorkspaceSocket(userId: string, workspaceId: string): Promise<{ socketPath: string }> {
    const workspace = await ownedWorkspace(userId, workspaceId);
    executionHostService.validateBinding(workspace.executionHostBinding, userId);
    if (workspace.executionHostBinding.host.kind === "local") {
      const socket = await openSocket(workspaceId, async (frame) => await scopedRequest({
        userId, scopeId: workspaceId,
        validate: async () => {
          const current = await ownedWorkspace(userId, workspaceId);
          if (current.executionHostBinding.host.kind !== "local"
            || current.executionHostBinding.host.nodeId !== workspace.executionHostBinding.host.nodeId) {
            throw sshAgentError("access_denied", "The workspace execution target changed.");
          }
          executionHostService.validateBinding(current.executionHostBinding, userId);
        },
      }, frame));
      return { socketPath: socket.socketPath };
    }
    const worker = getWorkerRegistrationByWorkspace(workspaceId, userId);
    if (!worker || worker.grantStatus !== "active" || worker.workerNodeId !== workspace.executionHostBinding.host.nodeId) {
      throw sshAgentError("access_denied", "SSH-key sockets require a dedicated verified workspace worker.");
    }
    return z.object({ socketPath: z.string().min(1) }).strict().parse(await callSshMeshPeer({
      nodeId: worker.workerNodeId, publicKey: worker.workerPublicKey, route: worker.route,
    }, { kind: "open-workspace" }));
  },
};

export async function receiveSshAgentOperation(request: MeshSshAgentRequest, verifiedPublicKey: string): Promise<unknown> {
  const operation = request.operation;
  if (operation.kind === "capability") return { sshAgent: MESH_SSH_AGENT_VERSION };
  if (getMeshRuntimeRole() === "controller") {
    if (operation.kind !== "workspace-request") throw sshAgentError("operation_forbidden", "The controller accepts only scoped SSH-agent workspace requests.");
    return (await scopedRequest(await workerAuthority(request.senderNodeId, verifiedPublicKey, operation.leaseId), decodeSshBase64(operation.frame))).toString("base64");
  }
  if (operation.kind === "source-list") return await listSourceAgentIdentities(sourceSocket);
  if (operation.kind === "source-sign") return (await signWithSourceAgent(sourceSocket, { ...operation, kind: "sign" })).toString("base64");
  if (operation.kind === "open-workspace") return { socketPath: (await workerSocket(request.senderNodeId)).socketPath };
  if (operation.kind === "open-lease") {
    if (operation.expiresAt <= Date.now() || operation.expiresAt > Date.now() + 30 * 60_000 || remoteSocketTimers.has(operation.leaseId)) {
      throw sshAgentError("access_denied", "The provisioning SSH-agent lease lifetime is invalid or already admitted.");
    }
    const socket = await workerSocket(request.senderNodeId, operation.leaseId);
    const timer = setTimeout(() => {
      remoteSocketTimers.delete(operation.leaseId);
      remoteSocketOwners.delete(operation.leaseId);
      void closeSocket(operation.leaseId).catch(() => {});
    }, operation.expiresAt - Date.now());
    timer.unref();
    remoteSocketTimers.set(operation.leaseId, timer);
    remoteSocketOwners.set(operation.leaseId, request.senderNodeId);
    return { socketPath: socket.socketPath };
  }
  if (operation.kind === "close-lease") {
    if (remoteSocketOwners.get(operation.leaseId) !== request.senderNodeId) throw sshAgentError("access_denied", "The provisioning socket belongs to another controller.");
    const timer = remoteSocketTimers.get(operation.leaseId);
    if (timer) clearTimeout(timer);
    remoteSocketTimers.delete(operation.leaseId);
    remoteSocketOwners.delete(operation.leaseId);
    await closeSocket(operation.leaseId);
    return { success: true };
  }
  throw sshAgentError("operation_forbidden", "The SSH-agent operation is not allowed on this node.");
}

export interface ProvisioningSshKeyLeaseOptions {
  userId: string;
  environmentId: string;
  provisioningOperationId: string;
  host: ExecutionHostRef;
  keyIds: readonly string[];
  ttlMs?: number;
  /** Revalidate the parent's admitted provisioning operation, including cancellation. */
  assertActive: () => void | Promise<void>;
}
export interface ProvisioningSshKeyLease {
  leaseId: string;
  socketPath: string;
  expiresAt: number;
  close(): Promise<void>;
}
export async function createProvisioningSshKeyLease(input: ProvisioningSshKeyLeaseOptions): Promise<ProvisioningSshKeyLease> {
  requireOwner(input.userId);
  await input.assertActive();
  z.string().uuid().parse(input.environmentId);
  z.string().uuid().parse(input.provisioningOperationId);
  const ttl = input.ttlMs ?? 15 * 60_000;
  if (leases.size >= 128) throw sshAgentError("unavailable", "The provisioning SSH-key lease capacity is exhausted.");
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 30 * 60_000 || input.keyIds.length > 256) throw sshAgentError("lease_invalid", "The provisioning SSH-key lease limits are invalid.");
  const keys = listSshPublicKeys(input.userId);
  for (const keyId of input.keyIds) if (!keys.some((key) => key.id === keyId)) throw sshAgentError("access_denied", "The provisioning key does not belong to this owner.");
  const host = await hostIdentity(input.userId, input.host);
  if ([...leases.values()].some((lease) => lease.userId === input.userId && lease.environmentId === input.environmentId)) {
    throw sshAgentError("lease_invalid", "This environment already has an active provisioning SSH-key lease.");
  }
  const id = crypto.randomUUID();
  const scopeId = `environment:${input.environmentId}`;
  replaceProvisioningSshKeyGrants(input.userId, scopeId, input.keyIds);
  const close = async (): Promise<void> => {
    const lease = leases.get(id);
    if (!lease) return;
    leases.delete(id);
    clearTimeout(lease.timer);
    await lease.closeRemote?.();
    await closeSocket(id);
  };
  const timer = setTimeout(() => { void close().catch(() => {}); }, ttl);
  timer.unref();
  const lease: ProvisioningLease = {
    id, userId: input.userId, scopeId, environmentId: input.environmentId, operationId: input.provisioningOperationId,
    host: input.host, hostFingerprint: host.fingerprint, keyIds: new Set(input.keyIds), expiresAt: Date.now() + ttl, timer,
    assertActive: input.assertActive,
  };
  leases.set(id, lease);
  try {
    let socketPath: string;
    if (host.peer) {
      const peer = host.peer;
      const remote = z.object({ socketPath: z.string().min(1) }).strict().parse(await callSshMeshPeer(peer, { kind: "open-lease", leaseId: id, expiresAt: lease.expiresAt }));
      socketPath = remote.socketPath;
      lease.closeRemote = async () => { await callSshMeshPeer(peer, { kind: "close-lease", leaseId: id }); };
    } else {
      socketPath = (await openSocket(id, async (frame) => await scopedRequest({
        userId: input.userId, scopeId, keyIds: lease.keyIds,
        validate: async () => {
          requireOwner(input.userId);
          if (leases.get(id) !== lease || Date.now() >= lease.expiresAt) throw sshAgentError("access_denied", "The provisioning SSH-key lease is expired or revoked.");
          await lease.assertActive();
        },
      }, frame))).socketPath;
    }
    await input.assertActive();
    if (leases.get(id) !== lease || Date.now() >= lease.expiresAt) throw sshAgentError("access_denied", "The provisioning SSH-key lease expired before socket admission completed.");
    return { leaseId: id, socketPath, expiresAt: lease.expiresAt, close };
  } catch (error) { await close().catch(() => {}); throw error; }
}
export async function attachProvisioningSshKeyGrants(userId: string, environmentId: string, workspaceId: string): Promise<void> {
  await ownedWorkspace(userId, workspaceId);
  transferSshKeyGrants(userId, `environment:${environmentId}`, workspaceId);
}
export async function revokeProvisioningSshKeyLease(userId: string, leaseId: string): Promise<void> {
  requireOwner(userId);
  const lease = leases.get(leaseId);
  if (!lease || lease.userId !== userId) throw sshAgentError("access_denied", "The provisioning SSH-key lease does not belong to this owner.");
  leases.delete(leaseId);
  clearTimeout(lease.timer);
  deleteSshScopeGrants(userId, lease.scopeId);
  await lease.closeRemote?.();
  await closeSocket(leaseId);
}
export async function removeWorkspaceSshKeyAccess(userId: string, workspaceId: string): Promise<void> {
  await ownedWorkspace(userId, workspaceId);
  deleteSshScopeGrants(userId, workspaceId);
  await closeSocket(workspaceId);
}
export async function discardProvisioningSshKeyGrants(userId: string, environmentId: string): Promise<void> {
  requireOwner(userId);
  for (const lease of [...leases.values()]) {
    if (lease.userId === userId && lease.environmentId === environmentId) await revokeProvisioningSshKeyLease(userId, lease.id);
  }
  deleteSshScopeGrants(userId, `environment:${environmentId}`);
}
export async function initializeWorkspaceSshAgentSocket(): Promise<void> {
  if (getMeshRuntimeRole() !== "worker" || process.env["CLANKY_WORKSPACE_SSH_AGENT"] !== "1") return;
  const socket = await openSocket("workspace", async (frame) => {
    const grants = await listActiveControllerGrants();
    if (grants.length !== 1) throw sshAgentError("access_denied", "A workspace SSH-agent requires exactly one active controller.");
    parseSshAgentRequest(frame);
    return decodeSshBase64(z.string().parse(await callSshMeshPeer(await controllerPeer(grants[0]!.controllerNodeId), {
      kind: "workspace-request", frame: frame.toString("base64"),
    })));
  });
  Object.assign(process.env, scopedSshAgentEnvironment(socket.socketPath));
}
export async function closeSshAgentSockets(): Promise<void> {
  for (const timer of remoteSocketTimers.values()) clearTimeout(timer);
  remoteSocketTimers.clear();
  remoteSocketOwners.clear();
  const activeLeases = [...leases.values()];
  for (const lease of activeLeases) clearTimeout(lease.timer);
  leases.clear();
  const results = await Promise.allSettled([
    ...activeLeases.flatMap((lease) => lease.closeRemote ? [lease.closeRemote()] : []),
    ...[...new Set([...sockets.keys(), ...openingSockets.keys()])].map(closeSocket),
  ]);
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "Scoped SSH-agent socket cleanup failed.");
}
