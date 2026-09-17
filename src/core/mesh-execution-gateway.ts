/**
 * Authenticated gateway for direct CommandExecutor operations on this host.
 *
 * This module is deliberately independent from BackendManager. The signed
 * caller supplies the execution root, provider, and channel. Relative paths
 * are resolved against the worker's configured directory. The controller grant
 * authorizes the receiving host without replicating workspace or user data.
 * Canonical paths and an operation lock scope requests to the configured worker
 * directory. The worker host itself remains trusted and is not treated as a
 * hostile filesystem.
 */

import { randomBytes } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import type {
  MeshExecutionAsyncCommandRequest,
  MeshExecutionRpcRequest,
  MeshExecutionSessionRequest,
} from "@/contracts/schemas/mesh-execution";
import {
  MESH_ACP_CHANNEL,
  MESH_EXECUTION_CHANNEL,
  MESH_EXECUTION_PROTOCOL_VERSION,
  MESH_EXECUTION_ASYNC_COMMAND_RETENTION_MS,
  MESH_EXECUTION_ASYNC_MAX_RETAINED_OUTPUT_BYTES,
  MESH_EXECUTION_ASYNC_MAX_COMMANDS,
  MESH_EXECUTION_DEFAULT_TIMEOUT_MS,
  MESH_EXECUTION_MAX_RESULT_BYTES,
  MESH_EXECUTION_MAX_MESSAGE_BYTES,
  MESH_EXECUTION_SESSION_TTL_MS,
  MESH_ACP_SESSION_TTL_MS,
} from "@/shared/mesh-execution";
import type {
  MeshExecutionAsyncCommandError,
  MeshExecutionAsyncCommandOutput,
  MeshExecutionAsyncCommandResult,
  MeshExecutionAsyncCommandSnapshot,
  MeshExecutionAsyncCommandStatus,
} from "@/shared/mesh-execution";
import { getControllerGrant } from "../persistence/mesh";
import {
  ensureLocalMeshNodeIdentity,
  requireLocalMeshExecutionAnyCapability,
  requireLocalMeshExecutionCapability,
  verifyMeshPayloadSignature,
} from "../persistence/mesh-node-identity";
import { getMeshWorkerDirectory } from "./mesh-runtime";
import { CommandExecutorImpl } from "./remote-command-executor";
import {
  isCommandOutputLimitError,
  type CommandExecutor,
  type CommandResult,
  type FileSystemDirectoryEntry,
  type FileSystemMetadata,
  type FileMoveResult,
  type FileWriteStreamOptions,
  type FileWriteStreamResult,
  type GitCommandScope,
} from "./command-executor";
import { DomainError } from "./domain-error";
import { buildMeshExecutionSessionSigningPayload } from "./mesh-protocol";
import type { AgentProvider } from "@/shared/settings";
import { requireTrustedController } from "./mesh-peer-auth";
import { meshInboundResourceRegistry } from "./mesh-inbound-resource-registry";
import { decryptMeshPayload } from "./mesh-payload-crypto";
import { parseManagedContextEnvironment } from "./managed-context-environment";
import {
  basenameExecutionPath,
  dirnameExecutionPath,
  executionPathStyleForPlatform,
  isAbsoluteExecutionPath,
  isExecutionPathWithinRoot,
  joinExecutionPath,
  normalizeExecutionRoot,
  resolveExecutionPath,
  type ExecutionPathStyle,
} from "./execution-path";
import {
  EXECUTION_HOST_CAPABILITY_VERSIONS,
  type ExecutionHostCapabilityId,
} from "@/shared/execution-host";
import type { MeshExecutionOperation } from "@/shared/mesh-execution";

const MAX_SESSIONS = 256;
const MAX_IN_FLIGHT_REQUESTS = 8;
const MAX_REQUEST_IDS = 512;
const EXCLUSIVE_EXECUTION_OPERATIONS = new Set<MeshExecutionOperation>([
  "writeFile",
  "copyFile",
  "movePath",
  "deletePath",
  "git",
]);

class AsyncReadWriteLock {
  private activeReaders = 0;
  private writerActive = false;
  private readonly waiters: Array<{
    mode: "read" | "write";
    resolve: (release: () => void) => void;
  }> = [];

  async acquire(mode: "read" | "write"): Promise<() => void> {
    return await new Promise<() => void>((resolve) => {
      this.waiters.push({ mode, resolve });
      this.drain();
    });
  }

  private drain(): void {
    if (this.writerActive || this.waiters.length === 0) {
      return;
    }
    if (this.waiters[0]!.mode === "write") {
      if (this.activeReaders > 0) {
        return;
      }
      const waiter = this.waiters.shift()!;
      this.writerActive = true;
      waiter.resolve(this.createRelease("write"));
      return;
    }
    while (this.waiters[0]?.mode === "read" && !this.writerActive) {
      const waiter = this.waiters.shift()!;
      this.activeReaders += 1;
      waiter.resolve(this.createRelease("read"));
    }
  }

  private createRelease(mode: "read" | "write"): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (mode === "write") {
        this.writerActive = false;
      } else {
        this.activeReaders -= 1;
      }
      this.drain();
    };
  }
}

interface MeshExecutionSession {
  sessionId: string;
  sessionToken: string;
  callerNodeId: string;
  workspaceId: string;
  executionRoot: string;
  physicalExecutionRoot: string;
  pathStyle: ExecutionPathStyle;
  directory: string;
  provider: AgentProvider;
  channel: typeof MESH_EXECUTION_CHANNEL | typeof MESH_ACP_CHANNEL;
  expiresAt: number;
  callerEncryptionPublicKey: string;
  environment?: Record<string, string>;
  executor: CommandExecutor;
  requestIds: Set<string>;
  activeControllers: Set<AbortController>;
  inFlight: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

export interface MeshExecutionSessionResponse {
  protocolVersion: typeof MESH_EXECUTION_PROTOCOL_VERSION;
  sessionId: string;
  sessionToken: string;
  executionRoot: string;
  expiresAt: string;
}

export interface MeshAcpSessionConfig {
  sessionId: string;
  sessionToken: string;
  provider: AgentProvider;
  directory: string;
  expiresAt: number;
  environment?: Record<string, string>;
}

interface ValidatedExecutionSession {
  session: MeshExecutionSession;
}

interface SessionValidationOptions {
  expectedChannel?: typeof MESH_ACP_CHANNEL;
  requiredCapability?: {
    id: ExecutionHostCapabilityId;
    minimumVersion?: number;
  };
  memberErrorCode: "mesh_execution_context_changed" | "mesh_peer_not_trusted";
}

type MeshExecutionRpcResult =
  | CommandResult
  | boolean
  | string
  | string[]
  | FileSystemMetadata
  | FileSystemDirectoryEntry[]
  | FileMoveResult
  | null;

interface MeshExecutionAsyncCommand {
  jobId: string;
  requestId: string;
  callerNodeId: string;
  workspaceId: string;
  executionRoot: string;
  provider: AgentProvider;
  channel: typeof MESH_EXECUTION_CHANNEL | typeof MESH_ACP_CHANNEL;
  executor: CommandExecutor;
  command: string;
  args: string[];
  cwd: string;
  timeout: number | null | undefined;
  maxOutputBytes: number;
  env?: Record<string, string>;
  stdout: string;
  stderr: string;
  controller: AbortController;
  status: MeshExecutionAsyncCommandStatus;
  result?: MeshExecutionAsyncCommandResult;
  error?: MeshExecutionAsyncCommandError;
  createdAt: number;
  completedAt?: number;
}

function assertStringSize(value: string, field: string): void {
  if (Buffer.byteLength(value, "utf8") > MESH_EXECUTION_MAX_RESULT_BYTES) {
    throw new DomainError(
      "mesh_execution_result_too_large",
      `The ${field} exceeds the mesh execution size limit.`,
    );
  }
}

export function assertMeshExecutionPath(
  root: string,
  requested: string,
  pathStyle: ExecutionPathStyle,
): string {
  try {
    return resolveExecutionPath(root, requested, pathStyle);
  } catch (error) {
    throw new DomainError(
      "mesh_execution_path_invalid",
      error instanceof Error ? error.message : "The execution path is invalid.",
      { cause: error },
    );
  }
}

export function assertMeshExecutionCwd(
  root: string,
  cwd: string,
  pathStyle: ExecutionPathStyle,
): string {
  return assertMeshExecutionPath(root, cwd, pathStyle);
}

interface SessionOperation {
  signal: AbortSignal;
  cleanup: () => void;
}

export interface TrustedExecutionRoot {
  executionRoot: string;
  physicalExecutionRoot: string;
  pathStyle: ExecutionPathStyle;
}

type PhysicalPathMode = "follow" | "entry" | "metadata";

const FILE_OPERATIONS_V2 = new Set<MeshExecutionOperation>([
  "getFileMetadata",
  "listDirectoryEntries",
  "movePath",
  "deletePath",
]);

export function getMeshExecutionOperationCapability(
  operation: MeshExecutionOperation,
): {
  id: "commandExecution" | "fileOperations" | "git" | "acpRuntime";
  minimumVersion: number;
} {
  if (operation === "exec") {
    return { id: "commandExecution", minimumVersion: 1 };
  }
  if (operation === "git" || operation === "gitEnvironment") {
    return {
      id: "git",
      minimumVersion: EXECUTION_HOST_CAPABILITY_VERSIONS.git,
    };
  }
  if (operation === "agentProviderAvailability") {
    return {
      id: "acpRuntime",
      minimumVersion: EXECUTION_HOST_CAPABILITY_VERSIONS.acpRuntime,
    };
  }
  return {
    id: "fileOperations",
    minimumVersion: FILE_OPERATIONS_V2.has(operation)
      ? EXECUTION_HOST_CAPABILITY_VERSIONS.fileOperations
      : 1,
  };
}

async function assertGitArguments(
  session: MeshExecutionSession,
  scope: GitCommandScope,
  args: string[],
): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand.startsWith("-")) {
    throw new DomainError(
      "mesh_execution_request_invalid",
      "Git operations require an explicit subcommand.",
    );
  }
  if (scope === "repository" && subcommand === "worktree") {
    throw new DomainError(
      "mesh_execution_request_invalid",
      "Git worktree commands require the managedWorktrees scope.",
    );
  }
  if (
    scope === "managedWorktrees"
    && !["worktree", "rev-parse", "symbolic-ref"].includes(subcommand)
  ) {
    throw new DomainError(
      "mesh_execution_request_invalid",
      "The managedWorktrees scope does not allow this Git subcommand.",
    );
  }
  if (scope !== "managedWorktrees" || subcommand !== "worktree") {
    return;
  }

  const action = args[1];
  let worktreePath: string | undefined;
  if (action === "list" && args.length === 3 && args[2] === "--porcelain") {
    return;
  }
  if (action === "prune" && args.length === 2) {
    return;
  }
  if (
    action === "remove"
    && (args.length === 3 || (args.length === 4 && args[3] === "--force"))
    && isGitOperand(args[2])
  ) {
    worktreePath = args[2];
  } else if (
    action === "add"
    && args.length === 4
    && isGitOperand(args[2])
    && isGitOperand(args[3])
  ) {
    worktreePath = args[2];
  } else if (
    action === "add"
    && (args.length === 5 || args.length === 6)
    && isGitOperand(args[2])
    && args[3] === "-b"
    && isGitOperand(args[4])
    && (args.length === 5 || isGitOperand(args[5]))
  ) {
    worktreePath = args[2];
  } else if (
    action === "add"
    && args.length === 6
    && args[2] === "--orphan"
    && args[3] === "-b"
    && isGitOperand(args[4])
    && isGitOperand(args[5])
  ) {
    worktreePath = args[5];
  } else {
    throw unsupportedManagedWorktreeCommand();
  }
  await assertPhysicalExecutionPath(session, worktreePath);
}

function isGitOperand(value: string | undefined): value is string {
  return Boolean(value && !value.startsWith("-"));
}

function unsupportedManagedWorktreeCommand(): DomainError {
  return new DomainError(
    "mesh_execution_request_invalid",
    "The managed worktree command is not supported.",
  );
}

function meshPathError(message: string, cause?: unknown): DomainError {
  return new DomainError(
    "mesh_execution_path_invalid",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function resolveExistingPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw meshPathError("The execution path could not be resolved.", error);
  }
}

export async function resolveTrustedExecutionRoot(
  workerRoot: string,
  requestedRoot: string,
  pathStyle: ExecutionPathStyle,
): Promise<TrustedExecutionRoot> {
  const executionRoot = assertMeshExecutionCwd(
    workerRoot,
    requestedRoot,
    pathStyle,
  );
  const physicalWorkerRoot = await resolveExistingPath(workerRoot);
  const physicalExecutionRoot = await resolveExistingPath(executionRoot);
  if (!isExecutionPathWithinRoot(
    physicalWorkerRoot,
    physicalExecutionRoot,
    pathStyle,
  )) {
    throw meshPathError(
      "The requested execution root must stay within the physical worker root.",
    );
  }
  return {
    executionRoot,
    physicalExecutionRoot,
    pathStyle,
  };
}

export async function assertPhysicalExecutionPath(
  session: Pick<
    MeshExecutionSession,
    "executionRoot" | "physicalExecutionRoot" | "pathStyle"
  >,
  requested: string,
  mode: PhysicalPathMode = "follow",
): Promise<string> {
  let candidate: string;
  try {
    candidate = assertMeshExecutionPath(
      session.executionRoot,
      requested,
      session.pathStyle,
    );
  } catch (error) {
    if (!isAbsoluteExecutionPath(requested, session.pathStyle)) {
      throw error;
    }
    let physicalCandidate: string;
    try {
      physicalCandidate = normalizeExecutionRoot(
        requested,
        session.pathStyle,
      );
    } catch {
      throw error;
    }
    if (!isExecutionPathWithinRoot(
      session.physicalExecutionRoot,
      physicalCandidate,
      session.pathStyle,
    )) {
      throw error;
    }
    candidate = physicalCandidate;
  }
  if (mode === "entry") {
    const parent = dirnameExecutionPath(candidate, session.pathStyle);
    const physicalParent = await assertPhysicalExecutionPath(
      session,
      parent,
      "follow",
    );
    return joinExecutionPath(
      session.pathStyle,
      physicalParent,
      basenameExecutionPath(candidate, session.pathStyle),
    );
  }

  const missingSegments: string[] = [];
  let existingPath = candidate;
  while (true) {
    try {
      const physicalPath = await realpath(existingPath);
      if (!isExecutionPathWithinRoot(
        session.physicalExecutionRoot,
        physicalPath,
        session.pathStyle,
      )) {
        throw meshPathError(
          "Requested path must stay within the physical execution root.",
        );
      }
      return missingSegments.reduceRight(
        (resolved, segment) => joinExecutionPath(
          session.pathStyle,
          resolved,
          segment,
        ),
        physicalPath,
      );
    } catch (error) {
      if (!isMissingPathError(error)) {
        if (error instanceof DomainError) {
          throw error;
        }
        throw meshPathError("The execution path could not be resolved.", error);
      }
      try {
        if ((await lstat(existingPath)).isSymbolicLink()) {
          if (mode === "metadata" && existingPath === candidate) {
            return await assertPhysicalExecutionPath(
              session,
              candidate,
              "entry",
            );
          }
          throw meshPathError(
            "The execution path contains an unresolved symbolic link.",
          );
        }
      } catch (linkError) {
        if (!isMissingPathError(linkError)) {
          if (linkError instanceof DomainError) {
            throw linkError;
          }
          throw meshPathError(
            "The execution path could not be inspected.",
            linkError,
          );
        }
      }
      const parent = dirnameExecutionPath(existingPath, session.pathStyle);
      if (parent === existingPath) {
        throw meshPathError("The execution path has no existing parent.");
      }
      missingSegments.push(
        basenameExecutionPath(existingPath, session.pathStyle),
      );
      existingPath = parent;
    }
  }
}

async function assertTrustedCaller(
  request: MeshExecutionSessionRequest,
): Promise<TrustedExecutionRoot> {
  const identity = await ensureLocalMeshNodeIdentity();
  if (request.targetNodeId !== identity.nodeId) {
    throw new DomainError("mesh_execution_target_invalid", "The execution request targets another mesh node.");
  }

  await requireTrustedController({
    controllerNodeId: request.callerNodeId,
    publicKey: request.callerPublicKey,
    fingerprint: request.callerFingerprint,
    encryptionPublicKey: request.callerEncryptionPublicKey,
    requireEncryptionKey: false,
    context: "execution caller",
  });
  const pathStyle = executionPathStyleForPlatform(process.platform);
  if (!pathStyle) {
    throw new DomainError(
      "mesh_execution_path_invalid",
      "The worker operating system does not provide supported path semantics.",
    );
  }
  return await resolveTrustedExecutionRoot(
    getMeshWorkerDirectory(),
    request.directory,
    pathStyle,
  );
}

export class MeshExecutionGateway {
  private readonly sessions = new Map<string, MeshExecutionSession>();
  private readonly asyncCommands = new Map<string, MeshExecutionAsyncCommand>();
  private readonly fileOperationsLock = new AsyncReadWriteLock();
  private readonly asyncCommandRequestIds = new Map<string, string>();
  private readonly usedNonces = new Map<string, number>();
  private retainedAsyncOutputBytes = 0;

  private scheduleSessionExpiry(session: MeshExecutionSession): void {
    if (session.expiryTimer !== undefined) {
      clearTimeout(session.expiryTimer);
    }
    const sessionId = session.sessionId;
    const expiryTimer = setTimeout(() => {
      const current = this.sessions.get(sessionId);
      if (current !== session || current.expiresAt > Date.now()) {
        return;
      }
      this.closeSession(sessionId);
    }, Math.max(1, session.expiresAt - Date.now()));
    expiryTimer.unref?.();
    session.expiryTimer = expiryTimer;
  }

  private pruneExpired(): void {
    const now = Date.now();
    this.pruneAsyncCommands(now);
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

  private pruneAsyncCommands(now: number = Date.now()): void {
    for (const [jobId, command] of this.asyncCommands) {
      if (
        command.completedAt !== undefined
        && now - command.completedAt >= MESH_EXECUTION_ASYNC_COMMAND_RETENTION_MS
      ) {
        this.removeAsyncCommand(jobId);
      }
    }
    while (this.asyncCommands.size > MESH_EXECUTION_ASYNC_MAX_COMMANDS) {
      if (!this.removeOldestTerminalAsyncCommand()) {
        break;
      }
    }
  }

  private removeOldestTerminalAsyncCommand(): boolean {
    const oldestTerminal = [...this.asyncCommands.values()]
      .filter((command) => command.completedAt !== undefined)
      .sort((left, right) => (left.completedAt ?? 0) - (right.completedAt ?? 0))[0];
    if (!oldestTerminal) {
      return false;
    }
    this.removeAsyncCommand(oldestTerminal.jobId);
    return true;
  }

  private removeAsyncCommand(jobId: string): void {
    const command = this.asyncCommands.get(jobId);
    if (!command) {
      return;
    }
    this.asyncCommands.delete(jobId);
    if (this.asyncCommandRequestIds.get(command.requestId) === jobId) {
      this.asyncCommandRequestIds.delete(command.requestId);
    }
    this.retainedAsyncOutputBytes -= this.getAsyncCommandOutputBytes(command);
    if (this.retainedAsyncOutputBytes < 0) {
      this.retainedAsyncOutputBytes = 0;
    }
  }

  private getAsyncCommandOutputBytes(command: MeshExecutionAsyncCommand): number {
    return Buffer.byteLength(command.stdout, "utf8") + Buffer.byteLength(command.stderr, "utf8");
  }

  private ensureAsyncOutputCapacity(additionalBytes: number): boolean {
    if (additionalBytes > MESH_EXECUTION_ASYNC_MAX_RETAINED_OUTPUT_BYTES) {
      return false;
    }
    while (
      this.retainedAsyncOutputBytes + additionalBytes
      > MESH_EXECUTION_ASYNC_MAX_RETAINED_OUTPUT_BYTES
    ) {
      const removed = this.removeOldestTerminalAsyncCommand();
      if (!removed) {
        return false;
      }
    }
    return this.retainedAsyncOutputBytes + additionalBytes
      <= MESH_EXECUTION_ASYNC_MAX_RETAINED_OUTPUT_BYTES;
  }

  private failAsyncCommand(
    command: MeshExecutionAsyncCommand,
    code: string,
    message: string,
  ): void {
    if (command.status !== "running") {
      return;
    }
    command.status = "failed";
    command.error = { code, message };
    command.completedAt = Date.now();
    command.controller.abort();
  }

  private appendAsyncCommandOutput(
    command: MeshExecutionAsyncCommand,
    stream: "stdout" | "stderr",
    chunk: string,
  ): void {
    if (command.status !== "running" || chunk.length === 0) {
      return;
    }
    const current = command[stream];
    const next = current + chunk;
    const additionalBytes = Buffer.byteLength(next, "utf8") - Buffer.byteLength(current, "utf8");
    if (!this.ensureAsyncOutputCapacity(additionalBytes)) {
      this.failAsyncCommand(
        command,
        "mesh_execution_result_too_large",
        "The worker output retention limit was exceeded.",
      );
      return;
    }
    command[stream] = next;
    this.retainedAsyncOutputBytes += additionalBytes;
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
    if (session.channel === MESH_ACP_CHANNEL) {
      await requireLocalMeshExecutionCapability("acpRuntime");
    }
    if (options.requiredCapability) {
      await requireLocalMeshExecutionCapability(
        options.requiredCapability.id,
        options.requiredCapability.minimumVersion,
      );
    } else if (session.channel !== MESH_ACP_CHANNEL) {
      await requireLocalMeshExecutionAnyCapability([
        "commandExecution",
        "fileOperations",
        "git",
        "acpRuntime",
      ]);
    }
    const grant = await getControllerGrant(session.callerNodeId);
    if (!grant || grant.grantStatus !== "active") {
      this.abortAsyncCommandsForCaller(session.callerNodeId);
      this.closeSession(session.sessionId);
      throw new DomainError(options.memberErrorCode, "The execution controller grant is no longer active.");
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
    if (request.channel === MESH_ACP_CHANNEL) {
      await requireLocalMeshExecutionCapability("acpRuntime");
    } else {
      await requireLocalMeshExecutionAnyCapability([
        "commandExecution",
        "fileOperations",
        "git",
      ]);
    }
    if (Buffer.byteLength(JSON.stringify(request), "utf8") > MESH_EXECUTION_MAX_MESSAGE_BYTES) {
      throw new DomainError(
        "mesh_execution_request_too_large",
        "The mesh execution session request exceeds the size limit.",
      );
    }
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

    const {
      executionRoot,
      physicalExecutionRoot,
      pathStyle,
    } = await assertTrustedCaller(request);
    const decryptedEnvironment = request.encryptedEnvironment === undefined
      ? undefined
      : await decryptMeshPayload(request.encryptedEnvironment);
    const environment = parseManagedContextEnvironment(decryptedEnvironment);
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
      callerNodeId: request.callerNodeId,
      workspaceId: request.workspaceId,
      executionRoot,
      physicalExecutionRoot,
      pathStyle,
      directory: executionRoot,
      provider: request.provider,
      channel: request.channel,
      expiresAt,
      callerEncryptionPublicKey: request.callerEncryptionPublicKey,
      environment,
      executor: new CommandExecutorImpl({
        provider: "local",
        directory: executionRoot,
        timeoutMs: MESH_EXECUTION_DEFAULT_TIMEOUT_MS,
      }),
      requestIds: new Set(),
      activeControllers: new Set(),
      inFlight: 0,
    };
    this.sessions.set(sessionId, sessionRecord);
    this.scheduleSessionExpiry(sessionRecord);
    return {
      protocolVersion: MESH_EXECUTION_PROTOCOL_VERSION,
      sessionId,
      sessionToken,
      executionRoot,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async renewSession(
    sessionId: string,
    sessionToken: string,
    expectedChannel?: typeof MESH_ACP_CHANNEL,
  ): Promise<number> {
    const validationOptions: SessionValidationOptions = {
      memberErrorCode: expectedChannel === MESH_ACP_CHANNEL
        ? "mesh_execution_context_changed"
        : "mesh_peer_not_trusted",
    };
    if (expectedChannel !== undefined) {
      validationOptions.expectedChannel = expectedChannel;
    }
    const { session } = await this.requireValidatedSession(
      sessionId,
      sessionToken,
      validationOptions,
    );
    if (
      this.sessions.get(sessionId) !== session
      || session.expiresAt <= Date.now()
    ) {
      this.closeSession(sessionId);
      throw new DomainError("mesh_execution_session_expired", "The execution session has expired.");
    }

    const maxSessionTtl = session.channel === MESH_ACP_CHANNEL
      ? MESH_ACP_SESSION_TTL_MS
      : MESH_EXECUTION_SESSION_TTL_MS;
    session.expiresAt = Date.now() + maxSessionTtl;
    this.scheduleSessionExpiry(session);
    return session.expiresAt;
  }

  releaseSession(
    sessionId: string,
    sessionToken: string,
  ): MeshExecutionSession["channel"] {
    const session = this.requireSessionRecord(sessionId, sessionToken);
    this.closeSession(sessionId);
    return session.channel;
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
      environment: session.environment,
    };
  }

  getSessionEncryptionPublicKey(sessionId: string, sessionToken: string): string {
    const session = this.requireSessionRecord(sessionId, sessionToken, "mesh_execution_session_invalid");
    if (!session.callerEncryptionPublicKey) {
      throw new DomainError("mesh_execution_encryption_unavailable", "The execution session has no encryption identity.");
    }
    return session.callerEncryptionPublicKey;
  }

  async startAsyncCommand(
    request: MeshExecutionAsyncCommandRequest,
  ): Promise<MeshExecutionAsyncCommandSnapshot> {
    const { session } = await this.requireValidatedSession(
      request.sessionId,
      request.sessionToken,
      {
        memberErrorCode: "mesh_peer_not_trusted",
        requiredCapability: {
          id: "commandExecution",
          minimumVersion: 1,
        },
      },
    );
    this.pruneAsyncCommands();
    if (Buffer.byteLength(JSON.stringify(request), "utf8") > MESH_EXECUTION_MAX_MESSAGE_BYTES) {
      throw new DomainError(
        "mesh_execution_request_too_large",
        "The asynchronous mesh execution request exceeds the size limit.",
      );
    }

    const existingJobId = this.asyncCommandRequestIds.get(request.requestId);
    if (existingJobId) {
      const existing = this.asyncCommands.get(existingJobId);
      if (existing) {
        if (!this.isSameAsyncCommandContext(existing, session)) {
          throw new DomainError(
            "mesh_execution_context_changed",
            "The asynchronous mesh command belongs to another execution context.",
          );
        }
        return this.getAsyncCommandSnapshot(existing);
      }
      this.asyncCommandRequestIds.delete(request.requestId);
    }

    this.claimRequestId(session, request.requestId);
    if (session.inFlight >= MAX_IN_FLIGHT_REQUESTS) {
      throw new DomainError("mesh_execution_limit_exceeded", "The execution session has too many in-flight requests.");
    }
    while (this.asyncCommands.size >= MESH_EXECUTION_ASYNC_MAX_COMMANDS) {
      if (!this.removeOldestTerminalAsyncCommand()) {
        break;
      }
    }
    if (this.asyncCommands.size >= MESH_EXECUTION_ASYNC_MAX_COMMANDS) {
      throw new DomainError("mesh_execution_limit_exceeded", "The execution worker has too many asynchronous commands.");
    }
    if (!request.command) {
      throw new DomainError("mesh_execution_request_invalid", "Asynchronous execution requires a command.");
    }

    const cwd = await assertPhysicalExecutionPath(
      session,
      request.cwd ?? session.directory,
    );
    const jobId = crypto.randomUUID();
    const command: MeshExecutionAsyncCommand = {
      jobId,
      requestId: request.requestId,
      callerNodeId: session.callerNodeId,
      workspaceId: session.workspaceId,
      executionRoot: session.executionRoot,
      provider: session.provider,
      channel: session.channel,
      executor: session.executor,
      command: request.command,
      args: request.args ?? [],
      cwd,
      timeout: request.timeout,
      maxOutputBytes: request.maxOutputBytes ?? MESH_EXECUTION_MAX_RESULT_BYTES,
      env: request.env,
      stdout: "",
      stderr: "",
      controller: new AbortController(),
      status: "running",
      createdAt: Date.now(),
    };
    this.asyncCommands.set(jobId, command);
    this.asyncCommandRequestIds.set(request.requestId, jobId);

    void this.runAsyncCommand(command);
    return this.getAsyncCommandSnapshot(command);
  }

  async getAsyncCommand(
    sessionId: string,
    sessionToken: string,
    jobId: string,
    requestId: string,
    stdoutOffset?: number,
    stderrOffset?: number,
  ): Promise<MeshExecutionAsyncCommandSnapshot> {
    const { session } = await this.requireValidatedSession(
      sessionId,
      sessionToken,
      { memberErrorCode: "mesh_peer_not_trusted" },
    );
    this.claimRequestId(session, requestId);
    const command = this.requireAsyncCommand(jobId, session);
    return this.getAsyncCommandSnapshot(command, { stdoutOffset, stderrOffset });
  }

  async cancelAsyncCommand(
    sessionId: string,
    sessionToken: string,
    jobId: string,
    requestId: string,
    stdoutOffset?: number,
    stderrOffset?: number,
  ): Promise<MeshExecutionAsyncCommandSnapshot> {
    const { session } = await this.requireValidatedSession(
      sessionId,
      sessionToken,
      { memberErrorCode: "mesh_peer_not_trusted" },
    );
    this.claimRequestId(session, requestId);
    const command = this.requireAsyncCommand(jobId, session);
    if (command.status === "running") {
      this.markAsyncCommandCancelled(command, {
        code: "mesh_execution_aborted",
        message: "The asynchronous mesh command was cancelled.",
      });
    }
    return this.getAsyncCommandSnapshot(command, { stdoutOffset, stderrOffset });
  }

  abortAsyncCommandsForCaller(callerNodeId: string): void {
    for (const command of this.asyncCommands.values()) {
      if (command.callerNodeId === callerNodeId && command.status === "running") {
        this.markAsyncCommandCancelled(command, {
          code: "mesh_execution_aborted",
          message: "The asynchronous mesh command was cancelled because its controller grant was revoked.",
        });
      }
    }
  }

  private markAsyncCommandCancelled(
    command: MeshExecutionAsyncCommand,
    error: MeshExecutionAsyncCommandError,
  ): void {
    if (command.status !== "running") {
      return;
    }
    command.status = "cancelled";
    command.error = { ...error };
    command.completedAt = Date.now();
    command.controller.abort();
  }

  private claimRequestId(session: MeshExecutionSession, requestId: string): void {
    if (session.requestIds.has(requestId)) {
      throw new DomainError("mesh_execution_replay", "The execution request has already been used.");
    }
    session.requestIds.add(requestId);
    while (session.requestIds.size > MAX_REQUEST_IDS) {
      const oldest = session.requestIds.values().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      session.requestIds.delete(oldest);
    }
  }

  private requireAsyncCommand(
    jobId: string,
    session: MeshExecutionSession,
  ): MeshExecutionAsyncCommand {
    this.pruneAsyncCommands();
    const command = this.asyncCommands.get(jobId);
    if (!command) {
      throw new DomainError(
        "mesh_execution_async_command_not_found",
        "The asynchronous mesh command was not found.",
      );
    }
    if (
      !this.isSameAsyncCommandContext(command, session)
    ) {
      throw new DomainError(
        "mesh_execution_context_changed",
        "The asynchronous mesh command belongs to another execution context.",
      );
    }
    return command;
  }

  private isSameAsyncCommandContext(
    command: MeshExecutionAsyncCommand,
    session: MeshExecutionSession,
  ): boolean {
    return command.callerNodeId === session.callerNodeId
      && command.workspaceId === session.workspaceId
      && command.executionRoot === session.executionRoot
      && command.provider === session.provider
      && command.channel === session.channel;
  }

  private getAsyncCommandSnapshot(
    command: MeshExecutionAsyncCommand,
    offsets?: {
      stdoutOffset?: number;
      stderrOffset?: number;
    },
  ): MeshExecutionAsyncCommandSnapshot {
    const stdoutOffset = this.getAsyncOutputOffset(
      command.stdout,
      offsets?.stdoutOffset,
      "stdout",
    );
    const stderrOffset = this.getAsyncOutputOffset(
      command.stderr,
      offsets?.stderrOffset,
      "stderr",
    );
    const output: MeshExecutionAsyncCommandOutput = {
      stdout: command.stdout.slice(stdoutOffset),
      stderr: command.stderr.slice(stderrOffset),
      stdoutOffset,
      stderrOffset,
      nextStdoutOffset: command.stdout.length,
      nextStderrOffset: command.stderr.length,
    };
    return {
      jobId: command.jobId,
      status: command.status,
      output,
      ...(command.result ? { result: { ...command.result } } : {}),
      ...(command.error ? { error: { ...command.error } } : {}),
    };
  }

  private getAsyncOutputOffset(
    output: string,
    requestedOffset: number | undefined,
    stream: "stdout" | "stderr",
  ): number {
    const offset = requestedOffset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > output.length) {
      throw new DomainError(
        "mesh_execution_output_offset_invalid",
        `The ${stream} output offset is invalid.`,
      );
    }
    return offset;
  }

  private async runAsyncCommand(command: MeshExecutionAsyncCommand): Promise<void> {
    try {
      const result = await command.executor.exec(command.command, command.args, {
        cwd: command.cwd,
        timeout: command.timeout,
        maxOutputBytes: command.maxOutputBytes,
        env: command.env,
        signal: command.controller.signal,
        logFailures: false,
        onStdoutChunk: (chunk) => this.appendAsyncCommandOutput(command, "stdout", chunk),
        onStderrChunk: (chunk) => this.appendAsyncCommandOutput(command, "stderr", chunk),
      });
      if (command.status === "running") {
        const previousOutputBytes = this.getAsyncCommandOutputBytes(command);
        command.stdout = result.stdout;
        command.stderr = result.stderr;
        const outputBytes = this.getAsyncCommandOutputBytes(command);
        const outputDelta = outputBytes - previousOutputBytes;
        if (outputDelta > 0 && !this.ensureAsyncOutputCapacity(outputDelta)) {
          this.failAsyncCommand(
            command,
            "mesh_execution_result_too_large",
            "The worker output retention limit was exceeded.",
          );
          return;
        }
        this.retainedAsyncOutputBytes += outputDelta;
        command.status = "completed";
        command.result = {
          success: result.success,
          stdout: command.stdout,
          stderr: command.stderr,
          exitCode: result.exitCode,
        };
        command.completedAt = Date.now();
      }
    } catch (error) {
      if (command.status === "cancelled" || command.controller.signal.aborted) {
        return;
      }
      command.status = "failed";
      command.error = {
        code: error instanceof DomainError
          ? error.code
          : isCommandOutputLimitError(error)
            ? "mesh_execution_result_too_large"
            : "mesh_execution_command_failed",
        message: String(error instanceof Error ? error.message : error),
      };
      command.completedAt = Date.now();
    }
  }

  async execute(request: MeshExecutionRpcRequest, signal?: AbortSignal): Promise<MeshExecutionRpcResult> {
    const requiredCapability = getMeshExecutionOperationCapability(
      request.operation,
    );
    const { session } = await this.requireValidatedSession(
      request.sessionId,
      request.sessionToken,
      {
        memberErrorCode: "mesh_peer_not_trusted",
        requiredCapability,
      },
    );
    if (
      request.operation === "git"
      && request.gitScope === "managedWorktrees"
    ) {
      await requireLocalMeshExecutionCapability(
        "managedWorktrees",
        EXECUTION_HOST_CAPABILITY_VERSIONS.managedWorktrees,
      );
    }

    this.claimRequestId(session, request.requestId);
    if (session.inFlight >= MAX_IN_FLIGHT_REQUESTS) {
      throw new DomainError("mesh_execution_limit_exceeded", "The execution session has too many in-flight requests.");
    }
    session.inFlight += 1;
    const releaseFileOperation = request.operation === "exec"
      ? undefined
      : await this.fileOperationsLock.acquire(
          EXCLUSIVE_EXECUTION_OPERATIONS.has(request.operation) ? "write" : "read",
        );

    try {
      const cwd = await assertPhysicalExecutionPath(
        session,
        request.cwd ?? session.directory,
      );
      const executor = session.executor;
      switch (request.operation) {
        case "exec": {
          if (!request.command) {
            throw new DomainError("mesh_execution_request_invalid", "exec requires a command.");
          }
          let result: CommandResult;
          try {
            result = await executor.exec(request.command, request.args ?? [], {
              cwd,
              timeout: request.timeout,
              maxOutputBytes: request.maxOutputBytes,
              env: request.env,
              signal,
              logFailures: false,
            });
          } catch (error) {
            if (isCommandOutputLimitError(error)) {
              throw new DomainError(
                "mesh_execution_result_too_large",
                `The ${error.stream} exceeds the mesh execution size limit.`,
                { cause: error },
              );
            }
            throw error;
          }
          assertStringSize(result.stdout, "stdout");
          assertStringSize(result.stderr, "stderr");
          return result;
        }
        case "git": {
          if (!request.args || !request.gitScope) {
            throw new DomainError(
              "mesh_execution_request_invalid",
              "git requires args and gitScope.",
            );
          }
          if (
            request.env
            && Object.keys(request.env).some(
              (name) => name !== "GIT_SSH_COMMAND",
            )
          ) {
            throw new DomainError(
              "mesh_execution_request_invalid",
              "Git operations only accept GIT_SSH_COMMAND.",
            );
          }
          await assertGitArguments(session, request.gitScope, request.args);
          let result: CommandResult;
          try {
            result = await executor.execGit(cwd, request.args, {
              scope: request.gitScope,
              timeout: request.timeout,
              maxOutputBytes: request.maxOutputBytes,
              env: request.env,
              signal,
              logFailures: false,
            });
          } catch (error) {
            if (isCommandOutputLimitError(error)) {
              throw new DomainError(
                "mesh_execution_result_too_large",
                `The ${error.stream} exceeds the mesh execution size limit.`,
                { cause: error },
              );
            }
            throw error;
          }
          assertStringSize(result.stdout, "stdout");
          assertStringSize(result.stderr, "stderr");
          return result;
        }
        case "gitEnvironment": {
          if (!request.gitEnvironmentName) {
            throw new DomainError(
              "mesh_execution_request_invalid",
              "gitEnvironment requires gitEnvironmentName.",
            );
          }
          const value = await executor.getGitEnvironmentVariable(
            request.gitEnvironmentName,
          );
          if (value !== null) {
            assertStringSize(value, "Git environment value");
          }
          return value;
        }
        case "agentProviderAvailability": {
          if (!request.agentProvider) {
            throw new DomainError(
              "mesh_execution_request_invalid",
              "agentProviderAvailability requires agentProvider.",
            );
          }
          return await executor.isAgentProviderAvailable(
            request.agentProvider,
          );
        }

        case "fileExists": {
          if (!request.path) {
            throw new DomainError(
              "mesh_execution_request_invalid",
              "fileExists requires a path.",
            );
          }
          return await executor.fileExists(await assertPhysicalExecutionPath(
            session,
            request.path,
          ));
        }
        case "directoryExists": {
          if (!request.path) {
            throw new DomainError(
              "mesh_execution_request_invalid",
              "directoryExists requires a path.",
            );
          }
          return await executor.directoryExists(await assertPhysicalExecutionPath(
            session,
            request.path,
          ));
        }
        case "readFile": {
          if (!request.path) {
            throw new DomainError(
              "mesh_execution_request_invalid",
              "readFile requires a path.",
            );
          }
          const content = await executor.readFile(await assertPhysicalExecutionPath(
            session,
            request.path,
          ));
          if (content !== null) assertStringSize(content, "file content");
          return content;
        }
        case "listDirectory": {
          const path = request.path
            ? await assertPhysicalExecutionPath(
                session,
                request.path,
              )
            : cwd;
          const entries = await executor.listDirectory(path, {
            includeHidden: request.includeHidden,
          });
          assertStringSize(JSON.stringify(entries), "directory listing");
          return entries;
        }
        case "writeFile": {
          if (!request.path || request.content === undefined) {
            throw new DomainError(
              "mesh_execution_request_invalid",
              "writeFile requires a path and content.",
            );
          }
          return await executor.writeFile(
            await assertPhysicalExecutionPath(
              session,
              request.path,
            ),
            request.content,
          );
        }
        case "copyFile": {
          if (!request.sourcePath || !request.destinationPath) {
            throw new DomainError(
              "mesh_execution_request_invalid",
              "copyFile requires sourcePath and destinationPath.",
            );
          }
          if (!executor.copyFile) {
            throw new DomainError(
              "mesh_execution_operation_unsupported",
              "The execution host does not support file copying.",
            );
          }
          return await executor.copyFile(
            await assertPhysicalExecutionPath(
              session,
              request.sourcePath,
            ),
            await assertPhysicalExecutionPath(
              session,
              request.destinationPath,
            ),
          );
        }
        case "getFileMetadata": {
          if (!request.path) {
            throw new DomainError(
              "mesh_execution_request_invalid",
              "getFileMetadata requires a path.",
            );
          }
          return await executor.getFileMetadata(
            await assertPhysicalExecutionPath(
              session,
              request.path,
              "metadata",
            ),
            { includeContentHash: request.includeContentHash },
          );
        }
        case "listDirectoryEntries": {
          if (!request.path) {
            throw new DomainError(
              "mesh_execution_request_invalid",
              "listDirectoryEntries requires a path.",
            );
          }
          const entries = await executor.listDirectoryEntries(
            await assertPhysicalExecutionPath(
              session,
              request.path,
            ),
            { includeHidden: request.includeHidden },
          );
          assertStringSize(JSON.stringify(entries), "directory entry listing");
          return entries;
        }
        case "movePath": {
          if (!request.sourcePath || !request.destinationPath) {
            throw new DomainError(
              "mesh_execution_request_invalid",
              "movePath requires sourcePath and destinationPath.",
            );
          }
          return await executor.movePath(
            await assertPhysicalExecutionPath(
              session,
              request.sourcePath,
              "entry",
            ),
            await assertPhysicalExecutionPath(
              session,
              request.destinationPath,
              "entry",
            ),
            { overwrite: request.overwrite },
          );
        }
        case "deletePath": {
          if (!request.path || !request.kind) {
            throw new DomainError(
              "mesh_execution_request_invalid",
              "deletePath requires a path and kind.",
            );
          }
          return await executor.deletePath(
            await assertPhysicalExecutionPath(
              session,
              request.path,
              "entry",
            ),
            {
              kind: request.kind,
              recursive: request.recursive,
            },
          );
        }
        default:
          throw new DomainError(
            "mesh_execution_request_invalid",
            "The mesh execution operation is not supported.",
          );
      }

    } finally {
      releaseFileOperation?.();
      session.inFlight -= 1;
    }
  }

  async streamFile(
    sessionId: string,
    sessionToken: string,
    requestedPath: string,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array> | null> {
    await requireLocalMeshExecutionCapability("fileOperations");
    const { session } = await this.requireValidatedSession(
      sessionId,
      sessionToken,
      { memberErrorCode: "mesh_peer_not_trusted" },
    );
    if (session.inFlight >= MAX_IN_FLIGHT_REQUESTS) {
      throw new DomainError("mesh_execution_limit_exceeded", "The execution session has too many in-flight requests.");
    }
    if (signal?.aborted) {
      throw new DomainError("mesh_execution_aborted", "The mesh execution request was aborted.");
    }

    const operation = this.startSessionOperation(session, signal);
    session.inFlight += 1;
    const releaseFileOperation = await this.fileOperationsLock.acquire("read");
    try {
      const path = await assertPhysicalExecutionPath(
        session,
        requestedPath,
      );
      const stream = await session.executor.streamFile(path, { signal: operation.signal });
      if (!stream) {
        releaseFileOperation();
        operation.cleanup();
        session.inFlight -= 1;
        return null;
      }
      return this.trackStream(stream, operation.signal, () => {
        releaseFileOperation();
        operation.cleanup();
        session.inFlight -= 1;
      });
    } catch (error) {
      releaseFileOperation();
      operation.cleanup();
      session.inFlight -= 1;
      throw error;
    }
  }

  async writeFileStream(
    sessionId: string,
    sessionToken: string,
    requestedPath: string,
    stream: ReadableStream<Uint8Array>,
    options?: FileWriteStreamOptions,
    signal?: AbortSignal,
  ): Promise<FileWriteStreamResult> {
    await requireLocalMeshExecutionCapability("fileOperations");
    const { session } = await this.requireValidatedSession(
      sessionId,
      sessionToken,
      { memberErrorCode: "mesh_peer_not_trusted" },
    );
    if (session.inFlight >= MAX_IN_FLIGHT_REQUESTS) {
      throw new DomainError("mesh_execution_limit_exceeded", "The execution session has too many in-flight requests.");
    }
    const writeFileStream = session.executor.writeFileStream;
    if (!writeFileStream) {
      throw new DomainError(
        "mesh_execution_operation_unsupported",
        "The execution host does not support streamed file writes.",
      );
    }
    if (signal?.aborted) {
      throw new DomainError("mesh_execution_aborted", "The mesh execution request was aborted.");
    }

    const operation = this.startSessionOperation(session, signal);
    session.inFlight += 1;
    const releaseFileOperation = await this.fileOperationsLock.acquire("write");
    try {
      const path = await assertPhysicalExecutionPath(
        session,
        requestedPath,
      );
      return await writeFileStream.call(session.executor, path, stream, {
        append: options?.append,
        expectedOffset: options?.expectedOffset,
        maxBytes: options?.maxBytes,
        signal: operation.signal,
      });
    } finally {
      releaseFileOperation();
      operation.cleanup();
      session.inFlight -= 1;
    }
  }

  private trackStream(
    stream: ReadableStream<Uint8Array>,
    signal: AbortSignal | undefined,
    onClosed: () => void,
  ): ReadableStream<Uint8Array> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let closed = false;
    const finish = () => {
      if (closed) return;
      try {
        reader?.releaseLock();
      } catch {
        // The reader can still be locked while an abort is being delivered.
      }
      closed = true;
      signal?.removeEventListener("abort", abortHandler);
      onClosed();
    };
    const abortHandler = () => {
      if (!reader) {
        finish();
        return;
      }
      void reader.cancel().catch(() => undefined).finally(finish);
    };
    signal?.addEventListener("abort", abortHandler, { once: true });
    if (signal?.aborted) {
      abortHandler();
    }

    return new ReadableStream<Uint8Array>({
      start() {
        reader = stream.getReader();
      },
      async pull(controller) {
        if (!reader) {
          controller.error(new DomainError(
            "mesh_execution_response_invalid",
            "The mesh file stream reader is unavailable.",
          ));
          finish();
          return;
        }
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            finish();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
          finish();
        }
      },
      async cancel(reason) {
        try {
          await reader?.cancel(reason);
        } finally {
          finish();
        }
      },
    });
  }

  private startSessionOperation(
    session: MeshExecutionSession,
    signal?: AbortSignal,
  ): SessionOperation {
    const controller = new AbortController();
    const abortHandler = () => controller.abort();
    if (signal?.aborted) {
      controller.abort();
    } else {
      signal?.addEventListener("abort", abortHandler, { once: true });
    }
    session.activeControllers.add(controller);
    let cleaned = false;
    return {
      signal: controller.signal,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        signal?.removeEventListener("abort", abortHandler);
        session.activeControllers.delete(controller);
      },
    };
  }

  closeAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.closeSession(sessionId);
    }
    for (const command of this.asyncCommands.values()) {
      if (command.status === "running") {
        this.markAsyncCommandCancelled(command, {
          code: "mesh_execution_aborted",
          message: "The asynchronous mesh command was cancelled because the execution gateway is closing.",
        });
      }
    }
    this.asyncCommands.clear();
    this.asyncCommandRequestIds.clear();
    this.retainedAsyncOutputBytes = 0;
    this.usedNonces.clear();
  }

  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    for (const controller of session.activeControllers) {
      controller.abort();
    }
    session.activeControllers.clear();
    this.sessions.delete(sessionId);
    if (session.expiryTimer !== undefined) {
      clearTimeout(session.expiryTimer);
      session.expiryTimer = undefined;
    }
  }
}

export const meshExecutionGateway = new MeshExecutionGateway();

meshInboundResourceRegistry.register({
  id: "execution",
  capabilities: [
    "commandExecution",
    "fileOperations",
    "git",
    "managedWorktrees",
    "acpRuntime",
  ],
  close: () => meshExecutionGateway.closeAll(),
});
