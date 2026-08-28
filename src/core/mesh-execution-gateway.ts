/**
 * Authenticated gateway for direct CommandExecutor operations on this host.
 *
 * This module is deliberately independent from BackendManager. The signed
 * caller supplies the absolute execution root, provider, and channel. The
 * receiving host deliberately does not load replicated workspace or user data.
 */

import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type {
  MeshExecutionRpcRequest,
  MeshExecutionSessionRequest,
} from "@/contracts/schemas/mesh-execution";
import {
  MESH_ACP_CHANNEL,
  MESH_EXECUTION_CHANNEL,
  MESH_EXECUTION_PROTOCOL_VERSION,
  MESH_EXECUTION_DEFAULT_TIMEOUT_MS,
  MESH_EXECUTION_MAX_RESULT_BYTES,
  MESH_EXECUTION_SESSION_TTL_MS,
  MESH_ACP_SESSION_TTL_MS,
} from "@/shared/mesh-execution";
import {
  getMeshLinkById,
  getMeshNode,
  listMeshLinkMembers,
} from "../persistence/mesh";
import {
  ensureLocalMeshNodeIdentity,
  verifyMeshPayloadSignature,
} from "../persistence/mesh-node-identity";
import { CommandExecutorImpl } from "./remote-command-executor";
import type { CommandExecutor, CommandResult } from "./command-executor";
import { DomainError } from "./domain-error";
import { buildMeshExecutionSessionSigningPayload } from "./mesh-protocol";
import type { AgentProvider } from "@/shared/settings";
import { requireTrustedMeshPeer } from "./mesh-peer-auth";
import {
  assertManagedWorktreePath,
} from "./git";

const MAX_SESSIONS = 256;
const MAX_IN_FLIGHT_REQUESTS = 8;
const MAX_REQUEST_IDS = 512;

interface MeshExecutionSession {
  sessionId: string;
  sessionToken: string;
  linkId: string;
  callerNodeId: string;
  executionRoot: string;
  directory: string;
  provider: AgentProvider;
  channel: typeof MESH_EXECUTION_CHANNEL | typeof MESH_ACP_CHANNEL;
  expiresAt: number;
  callerEncryptionPublicKey: string;
  executor: CommandExecutor;
  requestIds: Set<string>;
  inFlight: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
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

interface ValidatedExecutionSession {
  session: MeshExecutionSession;
}

interface SessionValidationOptions {
  expectedChannel?: typeof MESH_ACP_CHANNEL;
  memberErrorCode: "mesh_execution_context_changed" | "mesh_peer_not_trusted";
}

type MeshExecutionRpcResult =
  | CommandResult
  | boolean
  | string
  | string[]
  | null;

function assertStringSize(value: string, field: string): void {
  if (Buffer.byteLength(value, "utf8") > MESH_EXECUTION_MAX_RESULT_BYTES) {
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

async function assertTrustedCaller(request: MeshExecutionSessionRequest): Promise<void> {
  const identity = await ensureLocalMeshNodeIdentity();
  if (request.targetNodeId !== identity.nodeId) {
    throw new DomainError("mesh_execution_target_invalid", "The execution request targets another mesh node.");
  }

  const { link } = await requireTrustedMeshPeer({
    linkId: request.linkId,
    nodeId: request.callerNodeId,
    publicKey: request.callerPublicKey,
    fingerprint: request.callerFingerprint,
    encryptionPublicKey: request.callerEncryptionPublicKey,
    requireEncryptionKey: false,
    requireActiveNode: true,
    requireActiveMember: true,
    context: "execution caller",
  });
  if (link.status === "revoked") {
    throw new DomainError("mesh_link_revoked", "The mesh execution link has been revoked.");
  }
  assertMeshExecutionCwd(request.directory, request.directory);
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

  private requireSessionRecord(
    sessionId: string,
    sessionToken: string,
    expiredCode: "mesh_execution_session_expired" | "mesh_execution_session_invalid" =
      "mesh_execution_session_expired",
  ): MeshExecutionSession {
    this.pruneExpired();
    const session = this.sessions.get(sessionId);
    if (!session || session.sessionToken !== sessionToken) {
      throw new DomainError("mesh_execution_session_invalid", "The execution session is invalid.");
    }
    if (session.expiresAt <= Date.now()) {
      this.closeSession(session.sessionId);
      throw new DomainError(expiredCode, "The execution session has expired.");
    }
    return session;
  }

  private async requireValidatedSession(
    sessionId: string,
    sessionToken: string,
    options: SessionValidationOptions,
  ): Promise<ValidatedExecutionSession> {
    const session = this.requireSessionRecord(sessionId, sessionToken);
    const link = await getMeshLinkById(session.linkId);
    if (
      !link
      || link.status !== "active"
    ) {
      this.closeSession(session.sessionId);
      throw new DomainError("mesh_execution_context_changed", "The mesh execution link is no longer active.");
    }

    const member = (await listMeshLinkMembers(session.linkId))
      .find((candidate) => candidate.nodeId === session.callerNodeId);
    const node = await getMeshNode(session.callerNodeId);
    if (
      !member
      || member.status !== "active"
      || !node
      || node.status !== "active"
    ) {
      this.closeSession(session.sessionId);
      throw new DomainError(options.memberErrorCode, "The execution caller is no longer an active member.");
    }

    if (
      options.expectedChannel !== undefined
      && session.channel !== options.expectedChannel
    ) {
      this.closeSession(session.sessionId);
      throw new DomainError("mesh_execution_context_changed", "The mesh execution channel is no longer valid.");
    }

    return { session };
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
      ? MESH_ACP_SESSION_TTL_MS
      : MESH_EXECUTION_SESSION_TTL_MS;
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

    await assertTrustedCaller(request);
    this.usedNonces.set(request.nonce, new Date(request.expiresAt).getTime());
    const sessionId = crypto.randomUUID();
    const sessionToken = randomBytes(32).toString("base64url");
    const expiresAt = Math.min(
      new Date(request.expiresAt).getTime(),
      Date.now() + maxSessionTtl,
    );
    const sessionRecord: MeshExecutionSession = {
      sessionId,
      sessionToken,
      linkId: request.linkId,
      callerNodeId: request.callerNodeId,
      executionRoot: request.directory,
      directory: assertMeshExecutionCwd(request.directory, request.directory),
      provider: request.provider,
      channel: request.channel,
      expiresAt,
      callerEncryptionPublicKey: request.callerEncryptionPublicKey,
      executor: new CommandExecutorImpl({
        provider: "local",
        directory: request.directory,
        timeoutMs: MESH_EXECUTION_DEFAULT_TIMEOUT_MS,
      }),
      requestIds: new Set(),
      inFlight: 0,
    };
    const expiryTimer = setTimeout(() => {
      this.closeSession(sessionId);
    }, Math.max(1, expiresAt - Date.now()));
    expiryTimer.unref?.();
    sessionRecord.expiryTimer = expiryTimer;
    this.sessions.set(sessionId, sessionRecord);
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
    const { session } = await this.requireValidatedSession(sessionId, sessionToken, {
      expectedChannel: MESH_ACP_CHANNEL,
      memberErrorCode: "mesh_execution_context_changed",
    });
    return {
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      provider: session.provider,
      directory: session.directory,
      expiresAt: session.expiresAt,
    };
  }

  getSessionEncryptionPublicKey(sessionId: string, sessionToken: string): string {
    const session = this.requireSessionRecord(sessionId, sessionToken, "mesh_execution_session_invalid");
    if (!session.callerEncryptionPublicKey) {
      throw new DomainError("mesh_execution_encryption_unavailable", "The execution session has no encryption identity.");
    }
    return session.callerEncryptionPublicKey;
  }

  async execute(request: MeshExecutionRpcRequest): Promise<MeshExecutionRpcResult> {
    const { session } = await this.requireValidatedSession(
      request.sessionId,
      request.sessionToken,
      {
        memberErrorCode: "mesh_peer_not_trusted",
      },
    );

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
      const cwd = assertMeshExecutionCwd(session.executionRoot, request.cwd ?? session.directory);
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
        return await executor.fileExists(assertMeshExecutionPath(session.executionRoot, request.path));
        }
        case "directoryExists": {
        if (!request.path) throw new DomainError("mesh_execution_request_invalid", "directoryExists requires a path.");
        return await executor.directoryExists(assertMeshExecutionPath(session.executionRoot, request.path));
        }
        case "readFile": {
        if (!request.path) throw new DomainError("mesh_execution_request_invalid", "readFile requires a path.");
        const content = await executor.readFile(assertMeshExecutionPath(session.executionRoot, request.path));
        if (content !== null) assertStringSize(content, "file content");
        return content;
        }
        case "listDirectory": {
        const path = request.path
          ? assertMeshExecutionPath(session.executionRoot, request.path)
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
          assertMeshExecutionPath(session.executionRoot, request.path),
          request.content,
        );
        }
      }
    } finally {
      session.inFlight -= 1;
    }
  }

  closeAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.closeSession(sessionId);
    }
    this.usedNonces.clear();
  }

  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    this.sessions.delete(sessionId);
    if (session.expiryTimer !== undefined) {
      clearTimeout(session.expiryTimer);
      session.expiryTimer = undefined;
    }
  }
}

export const meshExecutionGateway = new MeshExecutionGateway();
