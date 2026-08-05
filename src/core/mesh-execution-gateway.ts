/**
 * Authenticated gateway for CommandExecutor operations on a local workspace.
 *
 * This module is deliberately independent from BackendManager. A future mesh
 * client can use the session and RPC contracts without changing the execution
 * host's local command implementation.
 */

import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import type {
  MeshExecutionRpcRequest,
  MeshExecutionSessionRequest,
} from "@/contracts/schemas/mesh-execution";
import type { Workspace } from "@/shared/workspace";
import {
  MESH_ACP_CHANNEL,
  MESH_EXECUTION_CHANNEL,
  MESH_EXECUTION_PROTOCOL_VERSION,
} from "@/shared/mesh-execution";
import { getWorkspace } from "../persistence/workspaces";
import { getDatabase } from "../persistence/database";
import {
  getMeshLinkById,
  getMeshNode,
  listMeshLinkMembers,
} from "../persistence/mesh";
import {
  ensureLocalMeshNodeIdentity,
  getMeshNodeFingerprint,
  verifyMeshPayloadSignature,
} from "../persistence/mesh-node-identity";
import { CommandExecutorImpl } from "./remote-command-executor";
import type { CommandExecutor, CommandResult } from "./command-executor";
import { DomainError } from "./domain-error";
import { buildMeshExecutionSessionSigningPayload } from "./mesh-protocol";
import { runWithCurrentUser } from "./user-context";
import type { AgentProvider } from "@/shared/settings";
import {
  assertManagedWorktreePath,
} from "./git";

const SESSION_TTL_MS = 60_000;
const MAX_SESSIONS = 256;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_IN_FLIGHT_REQUESTS = 8;
const MAX_REQUEST_IDS = 512;

interface RoutedWorkspace extends Workspace {
  executionNodeId?: string | null;
}

interface MeshExecutionSession {
  sessionId: string;
  sessionToken: string;
  linkId: string;
  callerNodeId: string;
  workspaceId: string;
  localUser: CurrentUser;
  workspaceRoot: string;
  directory: string;
  provider: AgentProvider;
  channel: typeof MESH_EXECUTION_CHANNEL | typeof MESH_ACP_CHANNEL;
  authorityGeneration: number;
  expiresAt: number;
  callerEncryptionPublicKey: string;
  executor: CommandExecutor;
  requestIds: Set<string>;
  inFlight: number;
}

export interface MeshExecutionSessionResponse {
  protocolVersion: typeof MESH_EXECUTION_PROTOCOL_VERSION;
  sessionId: string;
  sessionToken: string;
  expiresAt: string;
}

export interface MeshAcpSessionConfig {
  sessionId: string;
  sessionToken: string;
  provider: AgentProvider;
  directory: string;
  expiresAt: number;
}

type MeshExecutionRpcResult =
  | CommandResult
  | boolean
  | string
  | string[]
  | null;

function assertStringSize(value: string, field: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_RESULT_BYTES) {
    throw new DomainError(
      "mesh_execution_result_too_large",
      `The ${field} exceeds the mesh execution size limit.`,
    );
  }
}

export function assertMeshExecutionPath(root: string, requested: string): string {
  if (
    !root.startsWith("/")
    || !requested.startsWith("/")
    || root.includes("\0")
    || requested.includes("\0")
  ) {
    throw new DomainError("mesh_execution_path_invalid", "The execution path must be an absolute path without NUL bytes.");
  }
  const normalizedRoot = posix.resolve(root);
  const normalizedPath = posix.resolve(requested);
  if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}/`)) {
    throw new DomainError("mesh_execution_path_invalid", "The execution path is outside the workspace root.");
  }
  return normalizedPath;
}

export function assertMeshExecutionCwd(root: string, cwd: string): string {
  const normalized = assertMeshExecutionPath(root, cwd);
  if (normalized === posix.resolve(root)) {
    return normalized;
  }
  try {
    return assertManagedWorktreePath(root, normalized);
  } catch (error) {
    throw new DomainError(
      "mesh_execution_cwd_invalid",
      "The execution cwd must be the workspace root or a managed worktree.",
      { cause: error },
    );
  }
}

function toCurrentUser(row: {
  id: string;
  username: string;
  role: CurrentUser["role"];
}): CurrentUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    isOwner: row.role === "owner",
    isAdmin: row.role === "owner" || row.role === "admin",
  };
}

function getMeshUser(localUserId: string): CurrentUser {
  const row = getDatabase().query(`
    SELECT id, username, role
    FROM webapp_users
    WHERE id = ? AND disabled_at IS NULL
  `).get(localUserId) as {
    id: string;
    username: string;
    role: CurrentUser["role"];
  } | null;
  if (!row) {
    throw new DomainError("mesh_execution_user_not_found", "The mesh workspace owner is not available.");
  }
  return toCurrentUser(row);
}

async function assertTrustedCaller(request: MeshExecutionSessionRequest): Promise<{
  authorityGeneration: number;
  localUser: CurrentUser;
  workspace: RoutedWorkspace;
}> {
  const identity = await ensureLocalMeshNodeIdentity();
  if (request.targetNodeId !== identity.nodeId) {
    throw new DomainError("mesh_execution_target_invalid", "The execution request targets another mesh node.");
  }

  let fingerprint: string;
  try {
    fingerprint = getMeshNodeFingerprint(request.callerPublicKey);
  } catch (error) {
    throw new DomainError("mesh_peer_identity_invalid", "The execution caller identity is invalid.", { cause: error });
  }
  if (fingerprint !== request.callerFingerprint) {
    throw new DomainError("mesh_peer_identity_mismatch", "The execution caller fingerprint does not match its public key.");
  }

  const node = await getMeshNode(request.callerNodeId);
  if (!node || node.status !== "active") {
    throw new DomainError("mesh_peer_not_trusted", "The execution caller is not a trusted mesh node.");
  }
  if (node.fingerprint !== request.callerFingerprint || node.publicKey !== request.callerPublicKey) {
    throw new DomainError("mesh_peer_not_trusted", "The execution caller identity does not match the trusted node.");
  }
  if (
    node.encryptionPublicKey
    && node.encryptionPublicKey !== request.callerEncryptionPublicKey
  ) {
    throw new DomainError("mesh_peer_not_trusted", "The execution caller encryption identity does not match the trusted node.");
  }

  const link = await getMeshLinkById(request.linkId);
  if (!link) {
    throw new DomainError("mesh_link_not_found", "The mesh execution link was not found.");
  }
  if (link.status === "revoked") {
    throw new DomainError("mesh_link_revoked", "The mesh execution link has been revoked.");
  }
  if (link.status === "conflict") {
    throw new DomainError("mesh_link_conflict", "The mesh execution link has an unresolved authority conflict.");
  }
  if (link.activeNodeId !== request.callerNodeId) {
    throw new DomainError("mesh_execution_caller_not_active", "Only the active mesh node may open an execution session.");
  }
  const member = (await listMeshLinkMembers(request.linkId))
    .find((candidate) => candidate.nodeId === request.callerNodeId);
  if (!member || member.status !== "active") {
    throw new DomainError("mesh_peer_not_trusted", "The execution caller is not an active member of this mesh link.");
  }

  const localUser = getMeshUser(member.localUserId);
  const workspace = await runWithCurrentUser(localUser, () => getWorkspace(request.workspaceId));
  if (!workspace) {
    throw new DomainError("workspace_not_found", "The requested workspace is not owned by this mesh member.");
  }
  const routedWorkspace = workspace as RoutedWorkspace;
  if (routedWorkspace.serverSettings.agent.transport !== "stdio") {
    throw new DomainError("mesh_execution_transport_unsupported", "Only stdio workspaces may use mesh execution.");
  }
  if (routedWorkspace.executionNodeId !== identity.nodeId) {
    throw new DomainError("mesh_execution_owner_mismatch", "The workspace is not owned by this execution node.");
  }
  assertMeshExecutionCwd(routedWorkspace.directory, request.directory);

  return {
    authorityGeneration: link.takeoverGeneration,
    localUser,
    workspace: routedWorkspace,
  };
}

export class MeshExecutionGateway {
  private readonly sessions = new Map<string, MeshExecutionSession>();
  private readonly usedNonces = new Map<string, number>();

  private pruneExpired(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.closeSession(sessionId);
      }
    }
    for (const [nonce, expiresAt] of this.usedNonces) {
      if (expiresAt <= now) {
        this.usedNonces.delete(nonce);
      }
    }
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.closeSession(oldest);
    }
  }

  async createSession(request: MeshExecutionSessionRequest): Promise<MeshExecutionSessionResponse> {
    this.pruneExpired();
    if (
      typeof request.callerEncryptionPublicKey !== "string"
      || request.callerEncryptionPublicKey.trim().length === 0
    ) {
      throw new DomainError(
        "mesh_execution_encryption_key_invalid",
        "A non-empty caller encryption public key is required.",
      );
    }
    if (new Date(request.expiresAt).getTime() <= Date.now()) {
      throw new DomainError("mesh_execution_session_expired", "The execution session request has expired.");
    }
    const maxSessionTtl = request.channel === MESH_ACP_CHANNEL
      ? 30 * 60 * 1000
      : SESSION_TTL_MS;
    if (new Date(request.expiresAt).getTime() > Date.now() + maxSessionTtl) {
      throw new DomainError("mesh_execution_session_expiry_invalid", "The execution session expiry is too far in the future.");
    }
    if (this.usedNonces.has(request.nonce)) {
      throw new DomainError("mesh_execution_replay", "The execution session nonce has already been used.");
    }
    const { signature, ...unsigned } = request;
    if (!verifyMeshPayloadSignature(
      buildMeshExecutionSessionSigningPayload(unsigned),
      signature,
      request.callerPublicKey,
    )) {
      throw new DomainError("mesh_peer_signature_invalid", "The execution session signature is invalid.");
    }

    const { authorityGeneration, localUser, workspace } = await assertTrustedCaller(request);
    this.usedNonces.set(request.nonce, new Date(request.expiresAt).getTime());
    const sessionId = crypto.randomUUID();
    const sessionToken = randomBytes(32).toString("base64url");
    const expiresAt = Math.min(
      new Date(request.expiresAt).getTime(),
      Date.now() + maxSessionTtl,
    );
    this.sessions.set(sessionId, {
      sessionId,
      sessionToken,
      linkId: request.linkId,
      callerNodeId: request.callerNodeId,
      workspaceId: request.workspaceId,
      localUser,
      workspaceRoot: workspace.directory,
      directory: assertMeshExecutionCwd(workspace.directory, request.directory),
      provider: workspace.serverSettings.agent.provider,
      channel: request.channel,
      authorityGeneration,
      expiresAt,
      callerEncryptionPublicKey: request.callerEncryptionPublicKey,
      executor: new CommandExecutorImpl({
        provider: "local",
        directory: workspace.directory,
        timeoutMs: 30 * 60 * 1000,
      }),
      requestIds: new Set(),
      inFlight: 0,
    });
    return {
      protocolVersion: MESH_EXECUTION_PROTOCOL_VERSION,
      sessionId,
      sessionToken,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async getAcpSessionConfig(
    sessionId: string,
    sessionToken: string,
  ): Promise<MeshAcpSessionConfig> {
    this.pruneExpired();
    const session = this.sessions.get(sessionId);
    if (!session || session.sessionToken !== sessionToken) {
      throw new DomainError("mesh_execution_session_invalid", "The execution session is invalid.");
    }
    if (session.expiresAt <= Date.now()) {
      this.closeSession(session.sessionId);
      throw new DomainError("mesh_execution_session_expired", "The execution session has expired.");
    }

    const link = await getMeshLinkById(session.linkId);
    const member = link
      ? (await listMeshLinkMembers(session.linkId))
        .find((candidate) => candidate.nodeId === session.callerNodeId)
      : undefined;
    const identity = await ensureLocalMeshNodeIdentity();
    const workspace = await runWithCurrentUser(
      session.localUser,
      () => getWorkspace(session.workspaceId),
    );
    if (
      !link
      || link.status !== "active"
      || link.activeNodeId !== session.callerNodeId
      || link.takeoverGeneration !== session.authorityGeneration
      || !member
      || member.status !== "active"
      || !workspace
      || workspace.serverSettings.agent.transport !== "stdio"
      || workspace.executionNodeId !== identity.nodeId
      || workspace.directory !== session.workspaceRoot
      || session.channel !== MESH_ACP_CHANNEL
    ) {
      this.closeSession(session.sessionId);
      throw new DomainError("mesh_execution_authority_changed", "The mesh execution authority has changed.");
    }
    return {
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      provider: session.provider,
      directory: session.directory,
      expiresAt: session.expiresAt,
    };
  }

  getSessionEncryptionPublicKey(sessionId: string, sessionToken: string): string {
    const session = this.sessions.get(sessionId);
    if (!session || session.sessionToken !== sessionToken || session.expiresAt <= Date.now()) {
      throw new DomainError("mesh_execution_session_invalid", "The execution session is invalid.");
    }
    if (!session.callerEncryptionPublicKey) {
      throw new DomainError("mesh_execution_encryption_unavailable", "The execution session has no encryption identity.");
    }
    return session.callerEncryptionPublicKey;
  }

  async execute(request: MeshExecutionRpcRequest): Promise<MeshExecutionRpcResult> {
    this.pruneExpired();
    const session = this.sessions.get(request.sessionId);
    if (!session || session.sessionToken !== request.sessionToken) {
      throw new DomainError("mesh_execution_session_invalid", "The execution session is invalid.");
    }
    if (session.expiresAt <= Date.now()) {
      this.closeSession(session.sessionId);
      throw new DomainError("mesh_execution_session_expired", "The execution session has expired.");
    }

    const link = await getMeshLinkById(session.linkId);
    if (
      !link
      || link.status !== "active"
      || link.activeNodeId !== session.callerNodeId
      || link.takeoverGeneration !== session.authorityGeneration
    ) {
      this.closeSession(session.sessionId);
      throw new DomainError("mesh_execution_authority_changed", "The mesh execution authority has changed.");
    }
    const member = (await listMeshLinkMembers(session.linkId))
      .find((candidate) => candidate.nodeId === session.callerNodeId);
    if (!member || member.status !== "active" || member.localUserId !== session.localUser.id) {
      this.sessions.delete(session.sessionId);
      throw new DomainError("mesh_peer_not_trusted", "The execution caller is no longer an active member.");
    }
    const identity = await ensureLocalMeshNodeIdentity();
    const workspace = await runWithCurrentUser(
      session.localUser,
      () => getWorkspace(session.workspaceId),
    );
    const routedWorkspace = workspace as RoutedWorkspace | null;
    if (
      !routedWorkspace
      || routedWorkspace.serverSettings.agent.transport !== "stdio"
      || routedWorkspace.executionNodeId !== identity.nodeId
      || routedWorkspace.directory !== session.workspaceRoot
    ) {
      this.sessions.delete(session.sessionId);
      throw new DomainError("mesh_execution_owner_mismatch", "The workspace execution ownership has changed.");
    }

    if (session.requestIds.has(request.requestId)) {
      throw new DomainError("mesh_execution_replay", "The execution request has already been used.");
    }
    if (session.inFlight >= MAX_IN_FLIGHT_REQUESTS) {
      throw new DomainError("mesh_execution_limit_exceeded", "The execution session has too many in-flight requests.");
    }
    session.requestIds.add(request.requestId);
    while (session.requestIds.size > MAX_REQUEST_IDS) {
      const oldest = session.requestIds.values().next().value as string | undefined;
      if (!oldest) break;
      session.requestIds.delete(oldest);
    }
    session.inFlight += 1;

    try {
      const cwd = assertMeshExecutionCwd(session.workspaceRoot, request.cwd ?? session.directory);
      const executor = session.executor;
      switch (request.operation) {
        case "exec": {
        if (!request.command) {
          throw new DomainError("mesh_execution_request_invalid", "exec requires a command.");
        }
        const result = await executor.exec(request.command, request.args ?? [], {
          cwd,
          timeout: request.timeout,
          env: request.env,
          logFailures: false,
        });
        assertStringSize(result.stdout, "stdout");
        assertStringSize(result.stderr, "stderr");
        return result;
        }
        case "fileExists": {
        if (!request.path) throw new DomainError("mesh_execution_request_invalid", "fileExists requires a path.");
        return await executor.fileExists(assertMeshExecutionPath(session.workspaceRoot, request.path));
        }
        case "directoryExists": {
        if (!request.path) throw new DomainError("mesh_execution_request_invalid", "directoryExists requires a path.");
        return await executor.directoryExists(assertMeshExecutionPath(session.workspaceRoot, request.path));
        }
        case "readFile": {
        if (!request.path) throw new DomainError("mesh_execution_request_invalid", "readFile requires a path.");
        const content = await executor.readFile(assertMeshExecutionPath(session.workspaceRoot, request.path));
        if (content !== null) assertStringSize(content, "file content");
        return content;
        }
        case "listDirectory": {
        const path = request.path
          ? assertMeshExecutionPath(session.workspaceRoot, request.path)
          : cwd;
        const entries = await executor.listDirectory(path, { includeHidden: request.includeHidden });
        assertStringSize(JSON.stringify(entries), "directory listing");
        return entries;
        }
        case "writeFile": {
        if (!request.path || request.content === undefined) {
          throw new DomainError("mesh_execution_request_invalid", "writeFile requires a path and content.");
        }
        return await executor.writeFile(
          assertMeshExecutionPath(session.workspaceRoot, request.path),
          request.content,
        );
        }
      }
    } finally {
      session.inFlight -= 1;
    }
  }

  closeAll(): void {
    this.sessions.clear();
    this.usedNonces.clear();
  }

  closeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

export const meshExecutionGateway = new MeshExecutionGateway();
