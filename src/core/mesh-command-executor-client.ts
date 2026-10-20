/**
 * HTTP client for signed, encrypted mesh CommandExecutor sessions.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import type {
  MeshExecutionAsyncCommandRequest,
  MeshExecutionRpcRequest,
  MeshExecutionSessionCloseRequest,
  MeshExecutionSessionRequest,
  MeshExecutionSessionRenewalRequest,
} from "@/contracts/schemas/mesh-execution";
import { MeshDirectoryTreeResultSchema } from "@/contracts/schemas/mesh-execution";
import type { FileSystemTreeEntry } from "@/shared/file-system";
import {
  MESH_EXECUTION_ASYNC_POLL_INTERVAL_MS,
  MESH_EXECUTION_ASYNC_REQUEST_TIMEOUT_MS,
  MESH_EXECUTION_CHANNEL,
  MESH_ACP_CHANNEL,
  MESH_HARNESS_CHANNEL,
  MESH_EXECUTION_DEFAULT_TIMEOUT_MS,
  MESH_EXECUTION_SESSION_REQUEST_TIMEOUT_MS,
  MESH_EXECUTION_SESSION_REQUEST_TTL_MS,
  MESH_EXECUTION_SESSION_RENEWAL_LEAD_MS,
  MESH_ACP_SESSION_REQUEST_TTL_MS,
  MESH_EXECUTION_MAX_IN_FLIGHT_REQUESTS,
  MESH_EXECUTION_MAX_RESULT_BYTES,
  MESH_ACP_SESSION_RENEWAL_LEAD_MS,
  MESH_SESSION_RENEWAL_RETRY_MS,
  MESH_SESSION_RENEWAL_MAX_RETRY_MS,
  MESH_SESSION_RENEWAL_SAFETY_MARGIN_MS,
  type MeshExecutionProtocolVersion,
} from "@/shared/mesh-execution";
import { discoverMeshWorkerGeneration } from "./mesh-worker-generation";
import { isSupportedMeshProtocolVersion } from "@/shared/mesh-protocol";
import { assertHarnessMeshProtocol } from "./backend/harness-host-policy";
import type {
  MeshExecutionAsyncCommandSnapshot,
} from "@/shared/mesh-execution";
import type { MeshPeerRoute } from "@/shared/mesh";
import { getWorkerRegistration } from "../persistence/mesh";
import {
  ensureLocalMeshNodeIdentity,
  signMeshPayload,
} from "../persistence/mesh-node-identity";
import { decodeMeshPayload, encodeMeshEnvironment, type MeshPayloadFields } from "./mesh-payload";
import { buildMeshExecutionSessionSigningPayload } from "./mesh-protocol";
import { requestMeshPeer } from "./mesh-peer-transport";
import { isMeshRelayResponseInterrupted, MeshRelayStreamError } from "./mesh-relay-errors";
import { DomainError } from "../domain/domain-error";
import { requireCurrentUserId } from "../context/user-context";
import type {
  CommandOptions,
  CommandResult,
  FileDeleteOptions,
  FileMoveOptions,
  FileMoveResult,
  FileSystemDirectoryEntry,
  FileSystemListOptions,
  FileSystemMetadata,
  FileSystemMetadataOptions,
  FileSystemTreeOptions,
  FileWriteStreamOptions,
  FileWriteStreamResult,
  GitCommandOptions,
  GitEnvironmentVariableName,
} from "./command-executor";
import type { AgentProvider } from "@/shared/settings";
import type { HarnessAdapter } from "@/shared/settings";

const log = createLogger("core:mesh-command-executor-client");
const MAX_QUEUED_EXECUTION_REQUESTS = 1024 * 1024;

interface MeshRequestWaiter {
  resolve(release: () => void): void;
  reject(error: DomainError): void;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

export interface MeshCommandExecutorClientConfig {
  workspaceId: string;
  directory: string;
  executionNodeId: string;
  provider: AgentProvider;
  localUserId?: string;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  channel?: typeof MESH_EXECUTION_CHANNEL | typeof MESH_ACP_CHANNEL | typeof MESH_HARNESS_CHANNEL;
  adapter?: Exclude<HarnessAdapter, "acp">;
  sessionTtlMs?: number;
  managedEnvironment?: Record<string, string>;
}

export interface MeshExecutionSessionConnection {
  route: MeshPeerRoute;
  sessionId: string;
  sessionToken: string;
  protocolVersion: MeshExecutionProtocolVersion;
  workerEncryptionPublicKey: string;
}

interface MeshExecutionSession {
  sessionId: string;
  sessionToken: string;
  protocolVersion: MeshExecutionProtocolVersion;
  expiresAt: number;
  executionRoot?: string;
  renewable?: boolean;
}

interface MeshSessionResponse extends MeshPayloadFields {
  protocolVersion: MeshExecutionProtocolVersion;
  sessionId: string;
  expiresAt: string;
}

interface MeshSessionRenewalResponse {
  protocolVersion: MeshExecutionProtocolVersion;
  sessionId: string;
  expiresAt: string;
}

interface MeshRpcResponse extends MeshPayloadFields {
  protocolVersion: MeshExecutionProtocolVersion;
  requestId: string;
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("mesh_execution_response_invalid", message);
  }
  return value as Record<string, unknown>;
}

function parseResponseShape<T extends object>(
  value: unknown,
  required: readonly string[],
  message: string,
): T {
  const record = asRecord(value, message);
  for (const key of required) {
    if (!(key in record)) {
      throw new DomainError("mesh_execution_response_invalid", message, {
        details: { missingField: key },
      });
    }
  }
  return record as T;
}

function parseAsyncCommandSnapshot(value: unknown): MeshExecutionAsyncCommandSnapshot {
  const record = parseResponseShape<Record<string, unknown>>(
    value,
    ["jobId", "status"],
    "The mesh asynchronous command response is invalid.",
  );
  const jobId = record["jobId"];
  const status = record["status"];
  if (
    typeof jobId !== "string"
    || !["running", "completed", "failed", "cancelled"].includes(String(status))
  ) {
    throw new DomainError(
      "mesh_execution_response_invalid",
      "The mesh asynchronous command response is invalid.",
    );
  }

  const outputValue = record["output"];
  let output: MeshExecutionAsyncCommandSnapshot["output"];
  if (outputValue !== undefined) {
    const outputRecord = asRecord(
      outputValue,
      "The mesh asynchronous command output is invalid.",
    );
    const stdout = outputRecord["stdout"];
    const stderr = outputRecord["stderr"];
    const stdoutOffset = outputRecord["stdoutOffset"];
    const stderrOffset = outputRecord["stderrOffset"];
    const nextStdoutOffset = outputRecord["nextStdoutOffset"];
    const nextStderrOffset = outputRecord["nextStderrOffset"];
    if (
      typeof stdout !== "string"
      || typeof stderr !== "string"
      || typeof stdoutOffset !== "number"
      || !Number.isSafeInteger(stdoutOffset)
      || stdoutOffset < 0
      || typeof stderrOffset !== "number"
      || !Number.isSafeInteger(stderrOffset)
      || stderrOffset < 0
      || typeof nextStdoutOffset !== "number"
      || !Number.isSafeInteger(nextStdoutOffset)
      || nextStdoutOffset !== stdoutOffset + stdout.length
      || typeof nextStderrOffset !== "number"
      || !Number.isSafeInteger(nextStderrOffset)
      || nextStderrOffset !== stderrOffset + stderr.length
    ) {
      throw new DomainError(
        "mesh_execution_response_invalid",
        "The mesh asynchronous command output is invalid.",
      );
    }
    output = {
      stdout,
      stderr,
      stdoutOffset,
      stderrOffset,
      nextStdoutOffset,
      nextStderrOffset,
    };
  }

  const resultValue = record["result"];
  let result: MeshExecutionAsyncCommandSnapshot["result"];
  if (resultValue !== undefined) {
    const resultRecord = asRecord(
      resultValue,
      "The mesh asynchronous command result is invalid.",
    );
    if (
      typeof resultRecord["success"] !== "boolean"
      || typeof resultRecord["stdout"] !== "string"
      || typeof resultRecord["stderr"] !== "string"
      || typeof resultRecord["exitCode"] !== "number"
      || !Number.isSafeInteger(resultRecord["exitCode"])
      || (resultRecord["termination"] !== undefined
        && resultRecord["termination"] !== "confirmed"
        && resultRecord["termination"] !== "failed")
    ) {
      throw new DomainError(
        "mesh_execution_response_invalid",
        "The mesh asynchronous command result is invalid.",
      );
    }
    result = {
      success: resultRecord["success"],
      stdout: resultRecord["stdout"],
      stderr: resultRecord["stderr"],
      exitCode: resultRecord["exitCode"],
      ...(resultRecord["termination"] === "confirmed" || resultRecord["termination"] === "failed"
        ? { termination: resultRecord["termination"] }
        : {}),
    };
  }

  const errorValue = record["error"];
  let error: MeshExecutionAsyncCommandSnapshot["error"];
  if (errorValue !== undefined) {
    const errorRecord = asRecord(
      errorValue,
      "The mesh asynchronous command error is invalid.",
    );
    if (typeof errorRecord["code"] !== "string" || typeof errorRecord["message"] !== "string") {
      throw new DomainError(
        "mesh_execution_response_invalid",
        "The mesh asynchronous command error is invalid.",
      );
    }
    error = {
      code: errorRecord["code"],
      message: errorRecord["message"],
    };
  }

  return {
    jobId,
    status: status as MeshExecutionAsyncCommandSnapshot["status"],
    ...(output ? { output } : {}),
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
  };
}

export class MeshCommandExecutorClient {
  private readonly workspaceId: string;
  private readonly directory: string;
  private readonly executionNodeId: string;
  private readonly provider: AgentProvider;
  private readonly localUserId?: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly channel: typeof MESH_EXECUTION_CHANNEL | typeof MESH_ACP_CHANNEL | typeof MESH_HARNESS_CHANNEL;
  private readonly adapter?: Exclude<HarnessAdapter, "acp">;
  private readonly sessionTtlMs: number;
  private readonly managedEnvironment?: Record<string, string>;
  private session: MeshExecutionSession | null = null;
  private route: MeshPeerRoute | null = null;
  private openingSession: Promise<void> | null = null;
  private openingSessionController: AbortController | null = null;
  private callerNodeId: string | null = null;
  private workerEncryptionPublicKey = "";
  private sessionGeneration = 0;
  private sessionRenewalTimer: ReturnType<typeof setTimeout> | undefined;
  private sessionRenewalController: AbortController | null = null;
  private sessionRenewalAttempt = 0;
  private readonly activeStreamControllers = new Set<AbortController>();
  private readonly activeRequestControllers = new Set<AbortController>();
  private inFlightRequests = 0;
  private readonly requestWaiters: MeshRequestWaiter[] = [];

  constructor(config: MeshCommandExecutorClientConfig) {
    this.workspaceId = config.workspaceId;
    this.directory = config.directory;
    this.executionNodeId = config.executionNodeId;
    this.provider = config.provider;
    this.localUserId = config.localUserId;
    this.requestTimeoutMs = config.requestTimeoutMs ?? MESH_EXECUTION_DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    this.channel = config.channel ?? MESH_EXECUTION_CHANNEL;
    this.adapter = config.adapter;
    this.sessionTtlMs = config.sessionTtlMs
      ?? (this.channel !== MESH_EXECUTION_CHANNEL
        ? MESH_ACP_SESSION_REQUEST_TTL_MS
        : MESH_EXECUTION_SESSION_REQUEST_TTL_MS);
    this.managedEnvironment = config.managedEnvironment;
  }

  private requestAbortedError(signal?: AbortSignal): DomainError {
    return new DomainError("mesh_execution_aborted", "The mesh execution request was aborted.", {
      cause: signal?.reason,
    });
  }

  private async acquireRequestSlot(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw this.requestAbortedError(signal);
    if (
      this.inFlightRequests < MESH_EXECUTION_MAX_IN_FLIGHT_REQUESTS
      && this.requestWaiters.length === 0
    ) {
      this.inFlightRequests += 1;
      return this.createRequestSlotRelease();
    }
    if (this.requestWaiters.length >= MAX_QUEUED_EXECUTION_REQUESTS) {
      throw new DomainError(
        "mesh_execution_limit_exceeded",
        "The Mesh execution request queue is full.",
        { details: { queued: this.requestWaiters.length } },
      );
    }

    return await new Promise<() => void>((resolve, reject) => {
      const waiter: MeshRequestWaiter = { resolve, reject, signal };
      const abortHandler = (): void => {
        const index = this.requestWaiters.indexOf(waiter);
        if (index < 0) return;
        this.requestWaiters.splice(index, 1);
        signal?.removeEventListener("abort", abortHandler);
        reject(this.requestAbortedError(signal));
      };
      waiter.abortHandler = abortHandler;
      this.requestWaiters.push(waiter);
      signal?.addEventListener("abort", abortHandler, { once: true });
      if (signal?.aborted) abortHandler();
    });
  }

  private createRequestSlotRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseRequestSlot();
    };
  }

  private releaseRequestSlot(): void {
    const waiter = this.requestWaiters.shift();
    if (!waiter) {
      this.inFlightRequests -= 1;
      return;
    }
    waiter.signal?.removeEventListener("abort", waiter.abortHandler!);
    if (waiter.signal?.aborted) {
      waiter.reject(this.requestAbortedError(waiter.signal));
      this.releaseRequestSlot();
      return;
    }
    waiter.resolve(this.createRequestSlotRelease());
  }

  async openSession(signal?: AbortSignal): Promise<void> {
    if (this.openingSession) {
      await raceWithAbort(this.openingSession, signal);
      return;
    }
    this.resetSession();
    const generation = this.sessionGeneration;
    const controller = new AbortController();
    const abortHandler = (): void => {
      if (!controller.signal.aborted) {
        controller.abort(signal?.reason);
      }
    };
    if (signal?.aborted) {
      abortHandler();
    } else {
      signal?.addEventListener("abort", abortHandler, { once: true });
    }
    this.openingSessionController = controller;
    const opening = this.openSessionInternal(generation, controller.signal);
    this.openingSession = opening;
    try {
      await opening;
    } catch (error) {
      if (generation === this.sessionGeneration) {
        this.session = null;
        this.route = null;
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortHandler);
      if (this.openingSessionController === controller) {
        this.openingSessionController = null;
      }
      if (this.openingSession === opening) {
        this.openingSession = null;
      }
    }
  }

  private async openSessionInternal(generation: number, signal: AbortSignal): Promise<void> {
    throwIfMeshSessionOpeningAborted(signal);
    const identity = await ensureLocalMeshNodeIdentity();
    if (
      typeof identity.encryptionPublicKey !== "string"
      || identity.encryptionPublicKey.trim().length === 0
    ) {
      throw new DomainError(
        "mesh_execution_encryption_key_invalid",
        "The local mesh identity has no usable encryption public key.",
      );
    }
    throwIfMeshSessionOpeningAborted(signal);
    const callerEncryptionPublicKey = identity.encryptionPublicKey;
    const localUserId = this.localUserId ?? requireCurrentUserId();
    const registration = await getWorkerRegistration(this.executionNodeId, localUserId);
    throwIfMeshSessionOpeningAborted(signal);
    if (!registration || registration.grantStatus !== "active") {
      throw new DomainError(
        "mesh_execution_endpoint_unavailable",
        "The selected worker has no active registration or usable Mesh endpoint.",
      );
    }
    const route = registration.route;
    const protocolVersion: MeshExecutionProtocolVersion = await discoverMeshWorkerGeneration(registration, signal, this.fetchImpl);
    if (this.channel === MESH_HARNESS_CHANNEL) {
      if (!this.adapter) throw new DomainError("mesh_execution_protocol_mismatch", "A native Mesh lease requires an adapter.");
      assertHarnessMeshProtocol(this.adapter, protocolVersion);
    }

    const channel = this.channel;
    let environmentFields: ReturnType<typeof encodeMeshEnvironment> = {};
    if (this.managedEnvironment !== undefined) {
      if (!registration.workerEncryptionPublicKey) {
        throw new DomainError(
          "mesh_execution_environment_unavailable",
          "The selected Mesh worker cannot receive the managed runtime environment.",
        );
      }
      environmentFields = encodeMeshEnvironment(
        protocolVersion,
        this.managedEnvironment,
        registration.workerEncryptionPublicKey,
      );
    }
    const buildSessionRequest = async (
      sessionTtlMs: number,
    ): Promise<MeshExecutionSessionRequest> => {
      const unsigned: Omit<MeshExecutionSessionRequest, "signature"> = {
        protocolVersion,
        requestId: crypto.randomUUID(),
        callerNodeId: identity.nodeId,
        callerPublicKey: identity.publicKey,
        callerFingerprint: identity.fingerprint,
        callerEncryptionPublicKey,
        targetNodeId: this.executionNodeId,
        workspaceId: this.workspaceId,
        directory: this.directory,
        provider: this.provider,
        channel,
        ...(channel === MESH_HARNESS_CHANNEL ? { adapter: this.adapter, ownerId: localUserId } : {}),
        ...environmentFields,
        nonce: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + sessionTtlMs).toISOString(),
      };
      return {
        ...unsigned,
        signature: await signMeshPayload(buildMeshExecutionSessionSigningPayload(unsigned)),
      };
    };
    const postSessionRequest = async (
      request: MeshExecutionSessionRequest,
    ): Promise<unknown> => this.post("api/mesh/internal/execution/session", request, {
      "x-clanky-mesh-node-id": identity.nodeId,
      "x-clanky-mesh-request-id": request.requestId,
    }, signal, MESH_EXECUTION_SESSION_REQUEST_TIMEOUT_MS, "POST", route);

    let request = await buildSessionRequest(this.sessionTtlMs);
    let response: unknown;
    response = await postSessionRequest(request);
    const body = parseResponseShape<MeshSessionResponse>(
      response,
      ["protocolVersion", "sessionId", "expiresAt"],
      "The mesh execution session response is invalid.",
    );
    if (body.protocolVersion !== protocolVersion) {
      throw new DomainError("mesh_execution_protocol_mismatch", "The mesh execution protocol version is unsupported.");
    }
    if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
      throw new DomainError("mesh_execution_response_invalid", "The mesh execution session ID is invalid.");
    }
    const decrypted = asRecord(
      await decodeMeshPayload(protocolVersion, body),
      "The mesh execution session payload is invalid.",
    );
    if (typeof decrypted["sessionToken"] !== "string" || decrypted["sessionToken"].length < 32) {
      throw new DomainError("mesh_execution_response_invalid", "The mesh execution session token is invalid.");
    }
    const sessionToken = decrypted["sessionToken"];
    const executionRoot = typeof decrypted["executionRoot"] === "string"
      ? decrypted["executionRoot"]
      : undefined;
    const expiresAtMs = new Date(body.expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new DomainError("mesh_execution_session_expired", "The mesh execution session has expired.");
    }
    const remoteSession = {
      sessionId: body.sessionId,
      sessionToken,
      protocolVersion,
    };
    if (signal.aborted || generation !== this.sessionGeneration) {
      await this.releaseRemoteSession(
        route,
        identity.nodeId,
        remoteSession,
      );
      if (signal.aborted) {
        throw new DomainError("mesh_execution_aborted", "The mesh execution session opening was aborted.", {
          cause: signal.reason,
        });
      }
      throw new DomainError("mesh_execution_session_invalid", "The mesh execution session opening was superseded.");
    }
    this.callerNodeId = identity.nodeId;
    this.workerEncryptionPublicKey = registration.workerEncryptionPublicKey;
    this.route = route;
    this.session = {
      sessionId: body.sessionId,
      sessionToken,
      protocolVersion,
      expiresAt: expiresAtMs,
      renewable: decrypted["executionSessionRenewal"] === 1,
      ...(executionRoot ? { executionRoot } : {}),
    };
  }

  async getExecutionDirectory(): Promise<string | null> {
    await this.ensureSession();
    return this.session?.executionRoot ?? null;
  }

  getSessionConnection(): MeshExecutionSessionConnection {
    if (!this.session || !this.route || this.session.expiresAt <= Date.now()) {
      throw new DomainError("mesh_execution_session_invalid", "The mesh execution session is unavailable.");
    }

    return {
      route: this.route,
      sessionId: this.session.sessionId,
      sessionToken: this.session.sessionToken,
      protocolVersion: this.session.protocolVersion,
      workerEncryptionPublicKey: this.workerEncryptionPublicKey,
    };
  }

  startSessionRenewal(): void {
    if (!this.session || (this.channel === MESH_EXECUTION_CHANNEL && (
      !this.session.renewable || this.activeStreamControllers.size === 0
    ))) {
      return;
    }
    this.clearSessionRenewal();
    this.scheduleSessionRenewal(this.sessionGeneration);
  }

  private updateStreamSessionRenewal(): void {
    if (this.channel !== MESH_EXECUTION_CHANNEL) return;
    if (this.activeStreamControllers.size === 0) {
      this.clearSessionRenewal();
    } else if (!this.sessionRenewalTimer && !this.sessionRenewalController) {
      this.startSessionRenewal();
    }
  }

  private clearSessionRenewal(): void {
    if (this.sessionRenewalTimer !== undefined) {
      clearTimeout(this.sessionRenewalTimer);
      this.sessionRenewalTimer = undefined;
    }
    this.sessionRenewalController?.abort();
    this.sessionRenewalController = null;
    this.sessionRenewalAttempt = 0;
  }

  private scheduleSessionRenewal(generation: number, requestedDelayMs?: number): void {
    if (
      (this.channel === MESH_EXECUTION_CHANNEL && (
        !this.session?.renewable || this.activeStreamControllers.size === 0
      ))
      || generation !== this.sessionGeneration
      || !this.session
      || !this.route
    ) {
      return;
    }
    if (this.sessionRenewalTimer !== undefined) {
      clearTimeout(this.sessionRenewalTimer);
    }
    const remainingMs = Math.max(1, this.session.expiresAt - Date.now());
    if (remainingMs <= MESH_SESSION_RENEWAL_SAFETY_MARGIN_MS && this.channel !== MESH_EXECUTION_CHANNEL) {
      return;
    }
    const leadMs = this.channel === MESH_EXECUTION_CHANNEL
      ? MESH_EXECUTION_SESSION_RENEWAL_LEAD_MS
      : MESH_ACP_SESSION_RENEWAL_LEAD_MS;
    const defaultDelayMs = Math.max(1, remainingMs - leadMs);
    const latestSafeDelayMs = remainingMs - MESH_SESSION_RENEWAL_SAFETY_MARGIN_MS;
    const delayMs = Math.max(
      1,
      Math.min(requestedDelayMs ?? defaultDelayMs, latestSafeDelayMs),
    );
    const timer = setTimeout(() => {
      this.sessionRenewalTimer = undefined;
      void this.renewSession(generation);
    }, delayMs);
    timer.unref?.();
    this.sessionRenewalTimer = timer;
  }

  private async requestSessionRenewal(
    session: MeshExecutionSession,
    signal: AbortSignal,
  ): Promise<number> {
    const executionRenewal = this.channel === MESH_EXECUTION_CHANNEL;
    const requestId = crypto.randomUUID();
    const request: MeshExecutionSessionRenewalRequest | null = executionRenewal ? {
      action: "renew",
      protocolVersion: session.protocolVersion,
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      requestId,
    } : null;
    const response = await this.post(
      executionRenewal
        ? "api/mesh/internal/execution/session"
        : this.channel === MESH_HARNESS_CHANNEL
          ? "api/mesh/internal/harness/renew"
          : "api/mesh/internal/execution/acp/renew",
      request,
      {
        "x-clanky-mesh-protocol-version": String(session.protocolVersion),
        "x-clanky-mesh-session-id": session.sessionId,
        "x-clanky-mesh-session-token": session.sessionToken,
        ...(executionRenewal ? { "x-clanky-mesh-request-id": requestId } : {}),
      },
      signal,
      MESH_EXECUTION_SESSION_REQUEST_TIMEOUT_MS,
    );
    const body = parseResponseShape<MeshSessionRenewalResponse>(
      response,
      ["protocolVersion", "sessionId", "expiresAt"],
      "The mesh session renewal response is invalid.",
    );
    if (
      body.protocolVersion !== session.protocolVersion
      || body.sessionId !== session.sessionId
    ) {
      throw new DomainError(
        "mesh_execution_response_invalid",
        "The mesh session renewal response does not match the session.",
      );
    }
    const expiresAt = new Date(body.expiresAt).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new DomainError(
        "mesh_execution_session_expired",
        "The renewed mesh session has already expired.",
      );
    }
    return expiresAt;
  }

  private async renewSession(generation: number): Promise<void> {
    if (
      generation !== this.sessionGeneration
      || !this.session
      || !this.route
      || this.sessionRenewalController
    ) {
      return;
    }
    const session = this.session;
    const controller = new AbortController();
    this.sessionRenewalController = controller;
    const attempt = this.sessionRenewalAttempt + 1;
    try {
      const expiresAt = await this.requestSessionRenewal(session, controller.signal);
      if (
        generation !== this.sessionGeneration
        || this.session !== session
      ) {
        return;
      }
      this.session = { ...session, expiresAt };
      this.sessionRenewalAttempt = 0;
      this.scheduleSessionRenewal(generation);
    } catch (error) {
      if (
        controller.signal.aborted
        || generation !== this.sessionGeneration
        || this.session !== session
      ) {
        return;
      }
      this.sessionRenewalAttempt = attempt;
      const terminal = error instanceof DomainError && (
        error.code === "mesh_execution_session_expired"
        || error.code === "mesh_execution_session_invalid"
        || error.code === "mesh_execution_context_changed"
        || error.code === "mesh_acp_unavailable"
        || error.code === "mesh_execution_capability_unavailable"
        || error.code === "mesh_remote_execution_disabled"
        || error.code === "mesh_peer_not_trusted"
        || error.code === "mesh_execution_protocol_mismatch"
      );
      const retryDelayMs = Math.min(
        MESH_SESSION_RENEWAL_MAX_RETRY_MS,
        MESH_SESSION_RENEWAL_RETRY_MS * (2 ** Math.min(attempt - 1, 3)),
      );
      const remainingMs = Math.max(0, session.expiresAt - Date.now());
      const details = {
        sessionId: session.sessionId,
        attempt,
        remainingMs,
        error: String(error),
      };
      if (terminal || remainingMs <= MESH_SESSION_RENEWAL_SAFETY_MARGIN_MS) {
        log.error(terminal
          ? "Mesh session renewal became unrecoverable"
          : "Mesh session renewal window elapsed", details);
        if (this.channel === MESH_EXECUTION_CHANNEL) {
          const failure = error instanceof DomainError ? error : new DomainError(
            "mesh_execution_session_expired",
            "The Mesh file transfer session could not be renewed.",
            { cause: error },
          );
          for (const streamController of this.activeStreamControllers) {
            streamController.abort(failure);
          }
          this.session = null;
        }
      } else {
        log.warn("Mesh session renewal failed; retrying", details);
        this.scheduleSessionRenewal(generation, retryDelayMs);
      }
    } finally {
      if (this.sessionRenewalController === controller) {
        this.sessionRenewalController = null;
      }
    }
  }

  async exec(
    command: string,
    args: string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    if (options?.longRunning && this.channel === MESH_EXECUTION_CHANNEL) {
      return await this.execLongRunning(command, args, options);
    }
    const result = await this.execute<CommandResult>({
      operation: "exec",
      command,
      args,
      cwd: options?.cwd,
      timeout: options?.timeout,
      maxOutputBytes: options?.maxOutputBytes,
      env: options?.env,
    }, options?.signal, () => options?.onExecutionState?.("dispatched"));
    if (result.stdout || result.stderr) options?.onExecutionState?.("started");
    if (result.stdout) options?.onStdoutChunk?.(result.stdout);
    if (result.stderr) options?.onStderrChunk?.(result.stderr);
    options?.onExecutionState?.("finished");
    return result;
  }

  async execGit(
    directory: string,
    args: string[],
    options: GitCommandOptions,
  ): Promise<CommandResult> {
    const result = await this.execute<CommandResult>({
      operation: "git",
      cwd: directory,
      args,
      gitScope: options.scope,
      timeout: options.timeout,
      maxOutputBytes: options.maxOutputBytes,
      env: options.env,
    }, options.signal);
    if (result.stdout) options.onStdoutChunk?.(result.stdout);
    if (result.stderr) options.onStderrChunk?.(result.stderr);
    return result;
  }

  async getGitEnvironmentVariable(
    name: GitEnvironmentVariableName,
  ): Promise<string | null> {
    return await this.execute<string | null>({
      operation: "gitEnvironment",
      gitEnvironmentName: name,
    });
  }

  async isAgentProviderAvailable(provider: AgentProvider): Promise<boolean> {
    return await this.execute<boolean>({
      operation: "agentProviderAvailability",
      agentProvider: provider,
    });
  }

  private async execLongRunning(
    command: string,
    args: string[],
    options: CommandOptions,
  ): Promise<CommandResult> {
    let jobId: string | undefined;
    let remoteMayBeRunning = false;
    let startDispatched = false;
    let executionStarted = false;
    let resultReceived = false;
    let terminationConfirmed = false;
    const output = {
      stdout: "",
      stderr: "",
    };
    const startRequestId = crypto.randomUUID();
    const startOperation: Omit<
      MeshExecutionAsyncCommandRequest,
      "protocolVersion" | "sessionId" | "sessionToken" | "requestId"
    > = {
      action: "start",
      command,
      args,
      cwd: options.cwd,
      timeout: options.timeout,
      maxOutputBytes: options.maxOutputBytes,
      env: options.env,
    };
    try {
      if (options.signal?.aborted) {
        throw new DomainError("mesh_execution_aborted", "The mesh execution request was aborted.", {
          details: { terminationConfirmed: true },
        });
      }

      let started: MeshExecutionAsyncCommandSnapshot;
      try {
        started = await this.sendAsyncCommandRequest(startOperation, {
          signal: options.signal,
          requestId: startRequestId,
          retry: options.retryStart !== false && !options.preserveOnDisconnect,
          onDispatch: () => {
            startDispatched = true;
            options.onExecutionState?.("dispatched");
          },
        });
        startDispatched = true;
      } catch (error) {
        startDispatched ||= error instanceof DomainError
          && error.details["executionRequestDispatched"] === true;
        const status = error instanceof DomainError ? error.details["status"] : undefined;
        resultReceived = typeof status === "number" && ![502, 503, 504].includes(status);
        if (options.preserveOnDisconnect || options.retryStart === false || !options.signal?.aborted) {
          throw error;
        }
        try {
          started = await this.sendAsyncCommandRequest(startOperation, { requestId: startRequestId });
          jobId = started.jobId;
          remoteMayBeRunning = started.status === "running";
          terminationConfirmed = this.isAsyncTerminationConfirmed(started);
          this.consumeAsyncCommandOutput(started, output, options);
          if (remoteMayBeRunning) {
            const cancelled = await this.sendAsyncCommandRequest({
              action: "cancel",
              jobId,
              stdoutOffset: output.stdout.length,
              stderrOffset: output.stderr.length,
            });
            if (!executionStarted && (cancelled.output?.stdout || cancelled.output?.stderr)) {
              executionStarted = true;
              options.onExecutionState?.("started");
            }
            this.consumeAsyncCommandOutput(cancelled, output, options);
            remoteMayBeRunning = cancelled.status === "running";
            terminationConfirmed = this.isAsyncTerminationConfirmed(cancelled);
            if (cancelled.status === "completed" && cancelled.result) {
              this.consumeCompletedAsyncCommandOutput(cancelled.result, output, options);
              options.onExecutionState?.("finished");
              return cancelled.result;
            }
          }
        } catch (reconcileError) {
          throw new DomainError(
            "mesh_execution_aborted",
            "The asynchronous mesh command was aborted, but remote cancellation could not be confirmed.",
            { cause: reconcileError },
          );
        }
        throw new DomainError("mesh_execution_aborted", "The mesh execution request was aborted.", {
          cause: error,
          details: { terminationConfirmed },
        });
      }
      jobId = started.jobId;
      remoteMayBeRunning = started.status === "running";
      const observeExecution = (snapshot: MeshExecutionAsyncCommandSnapshot): void => {
        // A running snapshot acknowledges acceptance, not successful process spawn.
        if (!executionStarted && (snapshot.output?.stdout || snapshot.output?.stderr)) {
          executionStarted = true;
          options.onExecutionState?.("started");
        }
      };
      observeExecution(started);
      this.consumeAsyncCommandOutput(started, output, options);

      let snapshot = started;
      while (snapshot.status === "running") {
        await this.waitForAsyncCommandPoll(options.signal);
        snapshot = await this.sendAsyncCommandRequest({
          action: "status",
          jobId,
          stdoutOffset: output.stdout.length,
          stderrOffset: output.stderr.length,
        }, { signal: options.signal, retry: !options.preserveOnDisconnect });
        remoteMayBeRunning = snapshot.status === "running";
        observeExecution(snapshot);
        this.consumeAsyncCommandOutput(snapshot, output, options);
      }
      remoteMayBeRunning = false;
      resultReceived = true;
      terminationConfirmed = this.isAsyncTerminationConfirmed(snapshot);

      if (snapshot.status === "cancelled") {
        throw new DomainError(
          "mesh_execution_aborted",
          snapshot.error?.message ?? "The asynchronous mesh command was cancelled.",
          { details: { terminationConfirmed: this.isAsyncTerminationConfirmed(snapshot) } },
        );
      }
      if (snapshot.status === "failed") {
        throw new DomainError(
          snapshot.error?.code ?? "mesh_execution_command_failed",
          snapshot.error?.message ?? "The asynchronous mesh command failed.",
        );
      }
      if (!snapshot.result) {
        throw new DomainError(
          "mesh_execution_response_invalid",
          "The completed asynchronous mesh command has no result.",
        );
      }
      this.consumeCompletedAsyncCommandOutput(snapshot.result, output, options);
      options.onExecutionState?.("finished");
      return snapshot.result;
    } catch (error) {
      terminationConfirmed ||= error instanceof DomainError
        && error.details["terminationConfirmed"] === true;
      if (options.preserveOnDisconnect) {
        if (!(error instanceof DomainError)) throw error;
        throw new DomainError(error.code, error.message, {
          cause: error,
          details: {
            ...error.details,
            executionRequestDispatched: startDispatched,
            executionStarted,
            executionResultReceived: resultReceived,
            terminationConfirmed,
          },
        });
      }
      if (jobId && remoteMayBeRunning) {
        try {
          const cancelled = await this.sendAsyncCommandRequest({
            action: "cancel",
            jobId,
            stdoutOffset: output.stdout.length,
            stderrOffset: output.stderr.length,
          });
          if (!executionStarted && (cancelled.output?.stdout || cancelled.output?.stderr)) {
            executionStarted = true;
            options.onExecutionState?.("started");
          }
          this.consumeAsyncCommandOutput(cancelled, output, options);
          remoteMayBeRunning = cancelled.status === "running";
          terminationConfirmed = this.isAsyncTerminationConfirmed(cancelled);
          if (cancelled.status === "completed" && cancelled.result) {
            this.consumeCompletedAsyncCommandOutput(cancelled.result, output, options);
            options.onExecutionState?.("finished");
            return cancelled.result;
          }
          if (remoteMayBeRunning || !terminationConfirmed) {
            throw new DomainError(
              "mesh_execution_cancel_failed",
              "The asynchronous mesh command cancellation was not confirmed.",
            );
          }
        } catch (cancelError) {
          if (
            cancelError instanceof DomainError
            && cancelError.code === "mesh_execution_async_command_not_found"
          ) {
            throw error instanceof DomainError
              ? new DomainError(error.code, error.message, {
                  cause: error,
                  details: {
                    ...error.details,
                    executionRequestDispatched: startDispatched,
                    executionStarted,
                    executionResultReceived: resultReceived,
                    terminationConfirmed: false,
                  },
                })
              : error;
          }
          throw new DomainError(
            options.signal?.aborted
              ? "mesh_execution_aborted"
              : "mesh_execution_unreachable",
            options.signal?.aborted
              ? "The asynchronous mesh command was aborted, but remote cancellation could not be confirmed."
              : "The asynchronous mesh command failed, but remote cancellation could not be confirmed.",
            {
              cause: cancelError,
              details: {
                executionRequestDispatched: startDispatched,
                executionStarted,
                executionResultReceived: resultReceived,
                terminationConfirmed: false,
              },
            },
          );
        }
      }
      if (error instanceof DomainError) {
        throw new DomainError(error.code, error.message, {
          cause: error,
          details: {
            ...error.details,
            executionRequestDispatched: startDispatched,
            executionStarted,
            executionResultReceived: resultReceived,
            terminationConfirmed,
          },
        });
      }
      throw error;
    }
  }

  private isAsyncTerminationConfirmed(snapshot: MeshExecutionAsyncCommandSnapshot): boolean {
    return snapshot.result?.termination === "confirmed";
  }

  private consumeAsyncCommandOutput(
    snapshot: MeshExecutionAsyncCommandSnapshot,
    output: { stdout: string; stderr: string },
    options: CommandOptions,
  ): void {
    const next = snapshot.output;
    if (!next) {
      return;
    }
    if (
      next.stdoutOffset !== output.stdout.length
      || next.stderrOffset !== output.stderr.length
    ) {
      throw new DomainError(
        "mesh_execution_output_gap",
        "The asynchronous mesh command output could not be resumed without a gap.",
      );
    }
    output.stdout += next.stdout;
    output.stderr += next.stderr;
    if (next.stdout) options.onStdoutChunk?.(next.stdout);
    if (next.stderr) options.onStderrChunk?.(next.stderr);
  }

  private consumeCompletedAsyncCommandOutput(
    result: CommandResult,
    output: { stdout: string; stderr: string },
    options: CommandOptions,
  ): void {
    if (!result.stdout.startsWith(output.stdout) || !result.stderr.startsWith(output.stderr)) {
      throw new DomainError(
        "mesh_execution_output_gap",
        "The completed asynchronous mesh command output does not match the polled output.",
      );
    }
    const stdoutRemainder = result.stdout.slice(output.stdout.length);
    const stderrRemainder = result.stderr.slice(output.stderr.length);
    if (stdoutRemainder) options.onStdoutChunk?.(stdoutRemainder);
    if (stderrRemainder) options.onStderrChunk?.(stderrRemainder);
  }

  private async sendAsyncCommandRequest(
    operation: Omit<MeshExecutionAsyncCommandRequest, "protocolVersion" | "sessionId" | "sessionToken" | "requestId">,
    options: { signal?: AbortSignal; requestId?: string; retry?: boolean; onDispatch?: () => void } = {},
  ): Promise<MeshExecutionAsyncCommandSnapshot> {
    const { signal, requestId: requestIdOverride } = options;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal?.aborted) {
        throw new DomainError("mesh_execution_aborted", "The mesh execution request was aborted.");
      }
      const releaseSlot = await this.acquireRequestSlot(signal);
      let commandDispatched = false;
      try {
        if (signal?.aborted) throw this.requestAbortedError(signal);
        await this.ensureSession(signal);
        const session = this.session;
        if (!session || !this.route) {
          throw new DomainError("mesh_execution_session_invalid", "The mesh execution session is unavailable.");
        }
        const requestId = requestIdOverride ?? crypto.randomUUID();
        const request: MeshExecutionAsyncCommandRequest = {
          protocolVersion: session.protocolVersion,
          sessionId: session.sessionId,
          sessionToken: session.sessionToken,
          requestId,
          ...operation,
        };
        try {
          const response = await this.post(
            "api/mesh/internal/execution/async",
            request,
            {
              "x-clanky-mesh-session-id": session.sessionId,
              "x-clanky-mesh-request-id": requestId,
            },
            signal,
            MESH_EXECUTION_ASYNC_REQUEST_TIMEOUT_MS,
            "POST",
            this.route,
            options.onDispatch,
          );
          commandDispatched = true;
          const body = parseResponseShape<MeshRpcResponse>(
            response,
            ["protocolVersion", "requestId"],
            "The mesh asynchronous command response is invalid.",
          );
          if (body.protocolVersion !== session.protocolVersion || body.requestId !== requestId) {
            throw new DomainError(
              "mesh_execution_response_invalid",
              "The mesh asynchronous command response does not match the request.",
            );
          }
          return parseAsyncCommandSnapshot(await decodeMeshPayload(session.protocolVersion, body));
        } catch (error) {
          commandDispatched ||= error instanceof DomainError
            && error.details["requestDispatched"] === true;
          if (
            attempt === 0
            && options.retry !== false
            && error instanceof DomainError
            && (
              error.code === "mesh_execution_session_invalid"
              || error.code === "mesh_execution_session_expired"
              || error.code === "mesh_execution_context_changed"
              || (
                error.code === "mesh_execution_unreachable"
                || error.code === "mesh_execution_response_invalid"
              )
            )
          ) {
            this.session = null;
            continue;
          }
          throw error;
        }
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        throw new DomainError(error.code, error.message, {
          cause: error,
          details: { ...error.details, executionRequestDispatched: commandDispatched },
        });
      } finally {
        releaseSlot();
      }
    }

    throw new DomainError("mesh_execution_session_invalid", "The mesh execution session is unavailable.");
  }

  private async waitForAsyncCommandPoll(signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abortHandler);
        resolve();
      }, MESH_EXECUTION_ASYNC_POLL_INTERVAL_MS);
      const abortHandler = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", abortHandler);
        reject(new DomainError("mesh_execution_aborted", "The mesh execution request was aborted."));
      };
      if (signal?.aborted) {
        abortHandler();
        return;
      }
      signal?.addEventListener("abort", abortHandler, { once: true });
    });
  }

  async fileExists(path: string): Promise<boolean> {
    return await this.execute<boolean>({ operation: "fileExists", path });
  }

  async directoryExists(path: string): Promise<boolean> {
    return await this.execute<boolean>({ operation: "directoryExists", path });
  }

  async readFile(path: string, signal?: AbortSignal): Promise<string | null> {
    return await this.execute<string | null>({ operation: "readFile", path }, signal);
  }

  async listDirectory(path: string, options?: FileSystemListOptions): Promise<string[]> {
    return await this.execute<string[]>({
      operation: "listDirectory",
      path,
      includeHidden: options?.includeHidden,
    }, options?.signal);
  }

  async getFileMetadata(
    path: string,
    options?: FileSystemMetadataOptions,
  ): Promise<FileSystemMetadata | null> {
    return await this.execute<FileSystemMetadata | null>({
      operation: "getFileMetadata",
      path,
      includeContentHash: options?.includeContentHash,
    }, options?.signal);
  }

  async listDirectoryEntries(
    path: string,
    options?: FileSystemListOptions,
  ): Promise<FileSystemDirectoryEntry[]> {
    return await this.execute<FileSystemDirectoryEntry[]>({
      operation: "listDirectoryEntries",
      path,
      includeHidden: options?.includeHidden,
    }, options?.signal);
  }

  async walkDirectoryTree(
    path: string,
    options: FileSystemTreeOptions,
  ): Promise<FileSystemTreeEntry[]> {
    const response = await this.execute<unknown>({
      operation: "walkDirectoryTree",
      path,
      includeHidden: options.includeHidden,
      deferredDirectoryNames: [...options.deferredDirectoryNames],
    }, options.signal);
    const parsed = MeshDirectoryTreeResultSchema.safeParse(response);
    if (
      !parsed.success
      || Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > MESH_EXECUTION_MAX_RESULT_BYTES
    ) {
      throw new DomainError(
        "mesh_execution_response_invalid",
        "The Mesh directory tree response is invalid.",
        { cause: parsed.success ? undefined : parsed.error },
      );
    }
    return parsed.data;
  }

  async writeFile(path: string, content: string): Promise<boolean> {
    return await this.execute<boolean>({ operation: "writeFile", path, content });
  }

  async copyFile(sourcePath: string, destinationPath: string): Promise<boolean> {
    return await this.execute<boolean>({
      operation: "copyFile",
      sourcePath,
      destinationPath,
    });
  }

  async movePath(
    sourcePath: string,
    destinationPath: string,
    options?: FileMoveOptions,
  ): Promise<FileMoveResult> {
    return await this.execute<FileMoveResult>({
      operation: "movePath",
      sourcePath,
      destinationPath,
      overwrite: options?.overwrite,
    });
  }

  async deletePath(path: string, options: FileDeleteOptions): Promise<boolean> {
    return await this.execute<boolean>({
      operation: "deletePath",
      path,
      kind: options.kind,
      recursive: options.recursive,
    });
  }

  async writeFileStream(
    path: string,
    stream: ReadableStream<Uint8Array>,
    options?: FileWriteStreamOptions,
  ): Promise<FileWriteStreamResult> {
    const releaseSlot = await this.acquireRequestSlot(options?.signal);
    try {
      if (options?.signal?.aborted) throw this.requestAbortedError(options.signal);
      await this.ensureSession();
      const session = this.session;
      const route = this.route;
      if (!session || !route) {
        throw new DomainError("mesh_execution_session_invalid", "The mesh execution session is unavailable.");
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      const abortHandler = () => controller.abort();
      options?.signal?.addEventListener("abort", abortHandler, { once: true });
      if (options?.signal?.aborted) controller.abort();
      this.activeRequestControllers.add(controller);
      try {
        const query = new URLSearchParams({
          path,
          append: options?.append ? "1" : "0",
        });
        if (options?.expectedOffset !== undefined) {
          query.set("expectedOffset", String(options.expectedOffset));
        }
        if (options?.maxBytes !== undefined) {
          query.set("maxBytes", String(options.maxBytes));
        }

        const response = await requestMeshPeer(
          route,
          `api/mesh/internal/execution/file?${query.toString()}`,
          {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/octet-stream",
              "x-clanky-mesh-protocol-version": String(session.protocolVersion),
              "x-clanky-mesh-session-id": session.sessionId,
              "x-clanky-mesh-session-token": session.sessionToken,
            },
            body: stream,
            signal: controller.signal,
            fetch: this.fetchImpl,
          },
        );
        if (!response.ok) {
          throw await this.readErrorResponse(response);
        }
        const body = parseResponseShape<{
          success: unknown;
          bytesWritten: unknown;
          error?: unknown;
          errorCode?: unknown;
        }>(
          await response.json(),
          ["success", "bytesWritten"],
          "The mesh file write response is invalid.",
        );
        const success = body.success;
        const bytesWritten = body.bytesWritten;
        if (
          typeof success !== "boolean"
          || typeof bytesWritten !== "number"
          || !Number.isSafeInteger(bytesWritten)
          || bytesWritten < 0
          || (body.error !== undefined && typeof body.error !== "string")
          || (body.errorCode !== undefined && body.errorCode !== "size_limit")
        ) {
          throw new DomainError("mesh_execution_response_invalid", "The mesh file write response is invalid.");
        }
        return {
          success,
          bytesWritten,
          ...(typeof body.error === "string" ? { error: body.error } : {}),
          ...(body.errorCode === "size_limit" ? { errorCode: body.errorCode } : {}),
        };
      } catch (error) {
        if (error instanceof DomainError) {
          if (
            error.code === "mesh_execution_session_invalid"
            || error.code === "mesh_execution_session_expired"
            || error.code === "mesh_execution_context_changed"
          ) {
            this.session = null;
          }
          throw error;
        }
        if (options?.signal?.aborted) {
          throw new DomainError("mesh_execution_aborted", "The mesh execution request was aborted.", { cause: error });
        }
        if (controller.signal.aborted) {
          throw new DomainError("mesh_execution_unreachable", "The selected mesh execution peer could not be reached.", {
            cause: error,
          });
        }
        throw new DomainError("mesh_execution_unreachable", "The selected mesh execution peer could not be reached.", {
          cause: error,
        });
      } finally {
        clearTimeout(timeoutId);
        options?.signal?.removeEventListener("abort", abortHandler);
        this.activeRequestControllers.delete(controller);
      }
    } finally {
      releaseSlot();
    }
  }

  async streamFile(path: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array> | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal?.aborted) {
        throw new DomainError("mesh_execution_aborted", "The mesh execution request was aborted.");
      }
      const releaseSlot = await this.acquireRequestSlot(signal);
      let slotTransferred = false;
      try {
        if (signal?.aborted) throw this.requestAbortedError(signal);
        await this.ensureSession(signal);
        const session = this.session;
        const route = this.route;
        if (!session || !route) {
          throw new DomainError("mesh_execution_session_invalid", "The mesh execution session is unavailable.");
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);
        const abortHandler = () => controller.abort(signal?.reason);
        signal?.addEventListener("abort", abortHandler, { once: true });
        if (signal?.aborted) controller.abort(signal.reason);
        this.activeStreamControllers.add(controller);
        this.updateStreamSessionRenewal();
        try {
          const query = new URLSearchParams({ path });
          const response = await requestMeshPeer(
            route,
            `api/mesh/internal/execution/file?${query.toString()}`,
            {
              method: "GET",
              headers: {
                accept: "application/octet-stream",
                "x-clanky-mesh-protocol-version": String(session.protocolVersion),
                "x-clanky-mesh-session-id": session.sessionId,
                "x-clanky-mesh-session-token": session.sessionToken,
              },
              signal: controller.signal,
              fetch: this.fetchImpl,
            },
          );

          if (!response.ok) {
            const error = await this.readErrorResponse(response);
            if (
              attempt === 0
              && (
                error.code === "mesh_execution_session_invalid"
                || error.code === "mesh_execution_session_expired"
                || error.code === "mesh_execution_context_changed"
              )
            ) {
              this.session = null;
              continue;
            }
            throw error;
          }
          if (!response.body) {
            throw new DomainError("mesh_execution_response_invalid", "The mesh file response has no body.");
          }

          const stream = this.wrapFileStream(response.body, controller, releaseSlot, signal);
          slotTransferred = true;
          return stream;
        } catch (error) {
          if (error instanceof DomainError) {
            throw error;
          }
          if (signal?.aborted) {
            throw new DomainError("mesh_execution_aborted", "The mesh execution request was aborted.", { cause: error });
          }
          if (controller.signal.aborted) {
            throw new DomainError("mesh_execution_unreachable", "The selected mesh execution peer could not be reached.", {
              cause: error,
            });
          }
          throw new DomainError("mesh_execution_unreachable", "The selected mesh execution peer could not be reached.", {
            cause: error,
          });
        } finally {
          clearTimeout(timeoutId);
          signal?.removeEventListener("abort", abortHandler);
          if (!slotTransferred) {
            this.activeStreamControllers.delete(controller);
            this.updateStreamSessionRenewal();
          }
        }
      } finally {
        if (!slotTransferred) releaseSlot();
      }
    }

    throw new DomainError("mesh_execution_session_invalid", "The mesh execution session is unavailable.");
  }

  private async readErrorResponse(response: Response): Promise<DomainError> {
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const record = payload && typeof payload === "object"
      ? payload as Record<string, unknown>
      : {};
    return new DomainError(
      typeof record["error"] === "string" ? record["error"] : "mesh_execution_request_failed",
      typeof record["message"] === "string"
        ? record["message"]
        : "The mesh execution request was rejected.",
      { details: { status: response.status } },
    );
  }

  private wrapFileStream(
    stream: ReadableStream<Uint8Array>,
    controller: AbortController,
    releaseSlot: () => void,
    signal?: AbortSignal,
  ): ReadableStream<Uint8Array> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let output: ReadableStreamDefaultController<Uint8Array> | undefined;
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      try {
        reader?.releaseLock();
      } catch {
        // The reader can still be locked while an abort is being delivered.
      }
      settled = true;
      signal?.removeEventListener("abort", abortHandler);
      controller.signal.removeEventListener("abort", controllerAbortHandler);
      this.activeStreamControllers.delete(controller);
      this.updateStreamSessionRenewal();
      releaseSlot();
    };
    const cancelReader = (): void => {
      if (!reader) {
        cleanup();
        return;
      }
      void reader.cancel(controller.signal.reason).catch((error: unknown) => {
        log.debug("The aborted Mesh file reader could not be cancelled", { error: String(error) });
      }).finally(cleanup);
    };
    const abortHandler = () => controller.abort(signal?.reason);
    const controllerAbortHandler = () => {
      output?.error(controller.signal.reason instanceof DomainError
        ? controller.signal.reason
        : new DomainError(
          "mesh_execution_aborted",
          "The Mesh file transfer was aborted.",
          { cause: controller.signal.reason },
        ));
      cancelReader();
    };
    signal?.addEventListener("abort", abortHandler, { once: true });
    controller.signal.addEventListener("abort", controllerAbortHandler, { once: true });

    const wrappedStream = new ReadableStream<Uint8Array>({
      start(outputController) {
        output = outputController;
        reader = stream.getReader();
      },
      async pull(outputController) {
        if (settled || controller.signal.aborted) return;
        if (!reader) {
          outputController.error(new DomainError(
            "mesh_execution_response_invalid",
            "The mesh file stream reader is unavailable.",
          ));
          cleanup();
          return;
        }
        try {
          const { done, value } = await reader.read();
          if (settled || controller.signal.aborted) return;
          if (done) {
            outputController.close();
            cleanup();
            return;
          }
          outputController.enqueue(value);
        } catch (error) {
          if (!settled && !controller.signal.aborted) outputController.error(error);
          cleanup();
        }
      },
      async cancel(reason) {
        try {
          await reader?.cancel(reason);
        } finally {
          cleanup();
          controller.abort();
        }
      },
    });
    if (controller.signal.aborted) {
      controllerAbortHandler();
    } else if (signal?.aborted) {
      abortHandler();
    }
    return wrappedStream;
  }

  private async execute<T>(
    operation: Omit<MeshExecutionRpcRequest, "protocolVersion" | "sessionId" | "sessionToken" | "requestId" | "operation">
      & { operation: MeshExecutionRpcRequest["operation"] },
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal?.aborted) {
        throw new DomainError("mesh_execution_aborted", "The mesh execution request was aborted.");
      }
      const releaseSlot = await this.acquireRequestSlot(signal);
      let commandDispatched = false;
      try {
        if (signal?.aborted) throw this.requestAbortedError(signal);
        await this.ensureSession(signal);
        const session = this.session;
        if (!session || !this.route) {
          throw new DomainError("mesh_execution_session_invalid", "The mesh execution session is unavailable.");
        }
        const requestId = crypto.randomUUID();
        const request: MeshExecutionRpcRequest = {
          protocolVersion: session.protocolVersion,
          sessionId: session.sessionId,
          sessionToken: session.sessionToken,
          requestId,
          ...operation,
        };
        try {
          const response = await this.post(
            "api/mesh/internal/execution/rpc",
            request,
            {
              "x-clanky-mesh-session-id": session.sessionId,
              "x-clanky-mesh-request-id": requestId,
            },
            signal,
            (request.operation === "exec" || request.operation === "git")
              && request.timeout !== undefined
              && request.timeout !== null
              ? Math.max(this.requestTimeoutMs, request.timeout + 1_000)
              : undefined,
            "POST",
            this.route,
            onDispatch,
          );
          commandDispatched = true;
          const body = parseResponseShape<MeshRpcResponse>(
            response,
            ["protocolVersion", "requestId"],
            "The mesh execution RPC response is invalid.",
          );
          if (body.protocolVersion !== session.protocolVersion || body.requestId !== requestId) {
            throw new DomainError("mesh_execution_response_invalid", "The mesh execution RPC response does not match the request.");
          }
          return await decodeMeshPayload(session.protocolVersion, body) as T;
        } catch (error) {
          commandDispatched ||= error instanceof DomainError
            && error.details["requestDispatched"] === true;
          if (
            attempt === 0
            && error instanceof DomainError
            && (
              error.code === "mesh_execution_session_invalid"
              || error.code === "mesh_execution_session_expired"
              || error.code === "mesh_execution_context_changed"
            )
          ) {
            this.session = null;
            continue;
          }
          throw error;
        }
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        throw new DomainError(error.code, error.message, {
          cause: error,
          details: { ...error.details, executionRequestDispatched: commandDispatched },
        });
      } finally {
        releaseSlot();
      }
    }

    throw new DomainError("mesh_execution_session_invalid", "The mesh execution session is unavailable.");
  }

  async releaseSession(): Promise<void> {
    const session = this.session;
    const route = this.route;
    const callerNodeId = this.callerNodeId;
    this.closeSession();
    if (!session || !route || !callerNodeId) {
      return;
    }
    await this.releaseRemoteSession(route, callerNodeId, session);
  }

  closeSession(): void {
    this.cancelQueuedRequests();
    this.resetSession();
  }

  private cancelQueuedRequests(): void {
    for (const waiter of this.requestWaiters.splice(0)) {
      waiter.signal?.removeEventListener("abort", waiter.abortHandler!);
      waiter.reject(new DomainError(
        "mesh_execution_aborted",
        "The Mesh execution session closed before the request could start.",
      ));
    }
  }

  private resetSession(): void {
    this.sessionGeneration += 1;
    this.openingSessionController?.abort();
    this.openingSessionController = null;
    this.clearSessionRenewal();
    for (const controller of this.activeStreamControllers) {
      controller.abort();
    }
    this.activeStreamControllers.clear();
    for (const controller of this.activeRequestControllers) {
      controller.abort();
    }
    this.activeRequestControllers.clear();
    this.session = null;
    this.route = null;
    this.callerNodeId = null;
  }

  private async ensureSession(signal?: AbortSignal): Promise<void> {
    if (!this.session || this.session.expiresAt <= Date.now()) {
      await this.openSession(signal);
    }
  }

  private async post(
    path: string,
    body: unknown,
    headers: Record<string, string>,
    signal?: AbortSignal,
    requestTimeoutMs?: number,
    method: "POST" | "DELETE" = "POST",
    route: MeshPeerRoute | null = this.route,
    onDispatch?: () => void,
  ): Promise<unknown> {
    if (signal?.aborted) {
      throw new DomainError("mesh_execution_aborted", "The mesh execution request was aborted.");
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      requestTimeoutMs ?? this.requestTimeoutMs,
    );
    const abortHandler = () => controller.abort();
    signal?.addEventListener("abort", abortHandler, { once: true });
    let requestDispatched = false;
    try {
      if (!route) {
        throw new DomainError(
          "mesh_execution_endpoint_unavailable",
          "The selected worker has no usable Mesh route.",
        );
      }
      const request = {
        method,
        headers: {
          "content-type": "application/json",
          ...(typeof body === "object" && body !== null && "protocolVersion" in body
            && isSupportedMeshProtocolVersion(body.protocolVersion)
            ? { "x-clanky-mesh-protocol-version": String(body.protocolVersion) } : {}),
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        fetch: this.fetchImpl,
        onDispatch: () => {
          requestDispatched = true;
          onDispatch?.();
        },
      };
      const response = await requestMeshPeer(route, path, request);
      if (!response.ok) {
        let payload: unknown = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        const record = payload && typeof payload === "object"
          ? payload as Record<string, unknown>
          : {};
        const code = typeof record["error"] === "string"
          ? record["error"]
          : "mesh_execution_request_failed";
        const message = typeof record["message"] === "string"
          ? record["message"]
          : "The mesh execution request was rejected.";
        throw new DomainError(code, message, { details: { status: response.status } });
      }
      return await response.json();
    } catch (error) {
      if (error instanceof DomainError) {
        throw new DomainError(error.code, error.message, {
          cause: error,
          details: { ...error.details, requestDispatched },
        });
      }
      if (error instanceof SyntaxError
        || (error instanceof MeshRelayStreamError
          && !isMeshRelayResponseInterrupted(error)
          && ![503, 504].includes(error.status))) {
        throw new DomainError("mesh_execution_response_invalid", "The mesh execution response is invalid.", {
          cause: error,
          details: { requestDispatched },
        });
      }
      if (signal?.aborted) {
        throw new DomainError("mesh_execution_aborted", "The mesh execution request was aborted.", {
          cause: error,
          details: { requestDispatched },
        });
      }
      throw new DomainError("mesh_execution_unreachable", "The selected mesh execution peer could not be reached.", {
        cause: error,
        details: { requestDispatched },
      });
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abortHandler);
    }
  }

  private async releaseRemoteSession(
    route: MeshPeerRoute,
    callerNodeId: string,
    session: Pick<
      MeshExecutionSession,
      "sessionId" | "sessionToken" | "protocolVersion"
    >,
  ): Promise<void> {
    const requestId = crypto.randomUUID();
    const body: MeshExecutionSessionCloseRequest = {
      protocolVersion: session.protocolVersion,
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      requestId,
    };
    try {
      await this.post(
        "api/mesh/internal/execution/session",
        body,
        {
          "x-clanky-mesh-node-id": callerNodeId,
          "x-clanky-mesh-session-id": session.sessionId,
          "x-clanky-mesh-request-id": requestId,
        },
        undefined,
        MESH_EXECUTION_SESSION_REQUEST_TIMEOUT_MS,
        "DELETE",
        route,
      );
    } catch (error) {
      log.warn("Failed to release remote Mesh execution session", {
        executionNodeId: this.executionNodeId,
        sessionId: session.sessionId,
        error: String(error),
      });
    }
  }
}

function throwIfMeshSessionOpeningAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DomainError("mesh_execution_aborted", "The mesh execution session opening was aborted.", {
      cause: signal.reason,
    });
  }
}


async function raceWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return await operation;
  }
  throwIfMeshSessionOpeningAborted(signal);
  let abortHandler: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    abortHandler = () => reject(new DomainError(
      "mesh_execution_aborted",
      "The mesh execution session opening was aborted.",
      { cause: signal.reason },
    ));
    signal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    return await Promise.race([operation, abortPromise]);
  } finally {
    if (abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}
