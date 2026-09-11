/**
 * HTTP client for signed, encrypted mesh CommandExecutor sessions.
 */

import type {
  MeshExecutionAsyncCommandRequest,
  MeshExecutionRpcRequest,
  MeshExecutionSessionRequest,
} from "@/contracts/schemas/mesh-execution";
import {
  MESH_EXECUTION_ASYNC_POLL_INTERVAL_MS,
  MESH_EXECUTION_ASYNC_REQUEST_TIMEOUT_MS,
  MESH_EXECUTION_CHANNEL,
  MESH_ACP_CHANNEL,
  MESH_EXECUTION_PROTOCOL_VERSION,
  MESH_EXECUTION_DEFAULT_TIMEOUT_MS,
  MESH_EXECUTION_SESSION_REQUEST_TIMEOUT_MS,
  MESH_EXECUTION_SESSION_REQUEST_TTL_MS,
  MESH_ACP_SESSION_REQUEST_TTL_MS,
} from "@/shared/mesh-execution";
import type {
  MeshExecutionAsyncCommandSnapshot,
} from "@/shared/mesh-execution";
import { getWorkerRegistration } from "../persistence/mesh";
import {
  ensureLocalMeshNodeIdentity,
  signMeshPayload,
} from "../persistence/mesh-node-identity";
import { decryptMeshPayload, encryptMeshPayload } from "./mesh-payload-crypto";
import { buildMeshExecutionSessionSigningPayload } from "./mesh-protocol";
import { resolveMeshRoute } from "./mesh-transport-config";
import { getMeshWorkerTlsOptions } from "./mesh-peer-tls";
import { DomainError } from "./domain-error";
import { requireCurrentUserId } from "./user-context";
import type {
  CommandOptions,
  CommandResult,
  FileWriteStreamOptions,
  FileWriteStreamResult,
} from "./command-executor";
import type { AgentProvider } from "@/shared/settings";

export interface MeshCommandExecutorClientConfig {
  workspaceId: string;
  directory: string;
  executionNodeId: string;
  provider: AgentProvider;
  localUserId?: string;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  channel?: typeof MESH_EXECUTION_CHANNEL | typeof MESH_ACP_CHANNEL;
  sessionTtlMs?: number;
  managedEnvironment?: Record<string, string>;
}

export interface MeshExecutionSessionConnection {
  endpoint: string;
  sessionId: string;
  sessionToken: string;
  tls?: Bun.TLSOptions;
}

interface MeshExecutionSession {
  sessionId: string;
  sessionToken: string;
  expiresAt: number;
}

interface MeshSessionResponse {
  protocolVersion: typeof MESH_EXECUTION_PROTOCOL_VERSION;
  sessionId: string;
  expiresAt: string;
  encryptedPayload: unknown;
}

interface MeshRpcResponse {
  protocolVersion: typeof MESH_EXECUTION_PROTOCOL_VERSION;
  requestId: string;
  encryptedPayload: unknown;
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
  private readonly channel: typeof MESH_EXECUTION_CHANNEL | typeof MESH_ACP_CHANNEL;
  private readonly sessionTtlMs: number;
  private readonly managedEnvironment?: Record<string, string>;
  private session: MeshExecutionSession | null = null;
  private endpoint: string | null = null;
  private workerTls: Bun.TLSOptions | undefined;
  private openingSession: Promise<void> | null = null;
  private sessionGeneration = 0;
  private readonly activeStreamControllers = new Set<AbortController>();
  private readonly activeRequestControllers = new Set<AbortController>();

  constructor(config: MeshCommandExecutorClientConfig) {
    this.workspaceId = config.workspaceId;
    this.directory = config.directory;
    this.executionNodeId = config.executionNodeId;
    this.provider = config.provider;
    this.localUserId = config.localUserId;
    this.requestTimeoutMs = config.requestTimeoutMs ?? MESH_EXECUTION_DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    this.channel = config.channel ?? MESH_EXECUTION_CHANNEL;
    this.sessionTtlMs = config.sessionTtlMs
      ?? (this.channel === MESH_ACP_CHANNEL
        ? MESH_ACP_SESSION_REQUEST_TTL_MS
        : MESH_EXECUTION_SESSION_REQUEST_TTL_MS);
    this.managedEnvironment = config.managedEnvironment;
  }

  async openSession(): Promise<void> {
    if (this.openingSession) {
      await this.openingSession;
      return;
    }
    this.closeSession();
    const generation = this.sessionGeneration;
    const opening = this.openSessionInternal(generation);
    this.openingSession = opening;
    try {
      await opening;
    } catch (error) {
      if (generation === this.sessionGeneration) {
        this.session = null;
        this.endpoint = null;
        this.workerTls = undefined;
      }
      throw error;
    } finally {
      if (this.openingSession === opening) {
        this.openingSession = null;
      }
    }
  }

  private async openSessionInternal(generation: number): Promise<void> {
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
    const localUserId = this.localUserId ?? requireCurrentUserId();
    const registration = await getWorkerRegistration(this.executionNodeId, localUserId);
    const endpoint = registration?.workerEndpoint;
    if (!registration || registration.grantStatus !== "active" || !endpoint) {
      throw new DomainError(
        "mesh_execution_endpoint_unavailable",
        "The selected worker has no active registration or usable Mesh endpoint.",
      );
    }
    this.workerTls = getMeshWorkerTlsOptions(registration);

    const channel = this.channel;
    const expiresAt = new Date(Date.now() + this.sessionTtlMs).toISOString();
    let encryptedEnvironment: unknown;
    if (this.managedEnvironment !== undefined) {
      if (!registration.workerEncryptionPublicKey) {
        throw new DomainError(
          "mesh_execution_environment_unavailable",
          "The selected Mesh worker cannot receive the managed runtime environment.",
        );
      }
      encryptedEnvironment = encryptMeshPayload(
        this.managedEnvironment,
        registration.workerEncryptionPublicKey,
      );
    }
    const unsigned: Omit<MeshExecutionSessionRequest, "signature"> = {
      protocolVersion: MESH_EXECUTION_PROTOCOL_VERSION,
      requestId: crypto.randomUUID(),
      callerNodeId: identity.nodeId,
      callerPublicKey: identity.publicKey,
      callerFingerprint: identity.fingerprint,
      callerEncryptionPublicKey: identity.encryptionPublicKey,
      targetNodeId: this.executionNodeId,
      workspaceId: this.workspaceId,
      directory: this.directory,
      provider: this.provider,
      channel,
      ...(encryptedEnvironment === undefined ? {} : { encryptedEnvironment }),
      nonce: crypto.randomUUID(),
      expiresAt,
    };
    const request: MeshExecutionSessionRequest = {
      ...unsigned,
      signature: await signMeshPayload(buildMeshExecutionSessionSigningPayload(unsigned)),
    };
    const route = resolveMeshRoute(endpoint, "api/mesh/internal/execution/session");
    const response = await this.post(route, request, {
      "x-clanky-mesh-node-id": identity.nodeId,
      "x-clanky-mesh-request-id": request.requestId,
    }, undefined, MESH_EXECUTION_SESSION_REQUEST_TIMEOUT_MS);
    const body = parseResponseShape<MeshSessionResponse>(
      response,
      ["protocolVersion", "sessionId", "expiresAt", "encryptedPayload"],
      "The mesh execution session response is invalid.",
    );
    if (body.protocolVersion !== MESH_EXECUTION_PROTOCOL_VERSION) {
      throw new DomainError("mesh_execution_protocol_mismatch", "The mesh execution protocol version is unsupported.");
    }
    if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
      throw new DomainError("mesh_execution_response_invalid", "The mesh execution session ID is invalid.");
    }
    const decrypted = asRecord(
      await decryptMeshPayload(body.encryptedPayload),
      "The mesh execution session payload is invalid.",
    );
    if (typeof decrypted["sessionToken"] !== "string" || decrypted["sessionToken"].length < 32) {
      throw new DomainError("mesh_execution_response_invalid", "The mesh execution session token is invalid.");
    }
    const expiresAtMs = new Date(body.expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new DomainError("mesh_execution_session_expired", "The mesh execution session has expired.");
    }
    if (generation !== this.sessionGeneration) {
      throw new DomainError("mesh_execution_session_invalid", "The mesh execution session opening was superseded.");
    }
    this.endpoint = endpoint;
    this.session = {
      sessionId: body.sessionId,
      sessionToken: decrypted["sessionToken"],
      expiresAt: expiresAtMs,
    };
  }

  getSessionConnection(): MeshExecutionSessionConnection {
    if (!this.session || !this.endpoint || this.session.expiresAt <= Date.now()) {
      throw new DomainError("mesh_execution_session_invalid", "The mesh execution session is unavailable.");
    }

    return {
      endpoint: this.endpoint,
      sessionId: this.session.sessionId,
      sessionToken: this.session.sessionToken,
      tls: this.workerTls,
    };
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
    }, options?.signal);
    if (result.stdout) options?.onStdoutChunk?.(result.stdout);
    if (result.stderr) options?.onStderrChunk?.(result.stderr);
    return result;
  }

  private async execLongRunning(
    command: string,
    args: string[],
    options: CommandOptions,
  ): Promise<CommandResult> {
    let jobId: string | undefined;
    let remoteMayBeRunning = false;
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
        throw new DomainError("mesh_execution_aborted", "The mesh execution request was aborted.");
      }

      let started: MeshExecutionAsyncCommandSnapshot;
      try {
        started = await this.sendAsyncCommandRequest(startOperation, options.signal, startRequestId);
      } catch (error) {
        if (!options.signal?.aborted) {
          throw error;
        }
        try {
          started = await this.sendAsyncCommandRequest(startOperation, undefined, startRequestId);
          jobId = started.jobId;
          remoteMayBeRunning = started.status === "running";
          this.consumeAsyncCommandOutput(started, output, options);
          if (remoteMayBeRunning) {
            const cancelled = await this.sendAsyncCommandRequest({
              action: "cancel",
              jobId,
              stdoutOffset: output.stdout.length,
              stderrOffset: output.stderr.length,
            });
            this.consumeAsyncCommandOutput(cancelled, output, options);
            remoteMayBeRunning = cancelled.status === "running";
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
        });
      }
      jobId = started.jobId;
      remoteMayBeRunning = started.status === "running";
      this.consumeAsyncCommandOutput(started, output, options);

      let snapshot = started;
      while (snapshot.status === "running") {
        await this.waitForAsyncCommandPoll(options.signal);
        snapshot = await this.sendAsyncCommandRequest({
          action: "status",
          jobId,
          stdoutOffset: output.stdout.length,
          stderrOffset: output.stderr.length,
        }, options.signal);
        remoteMayBeRunning = snapshot.status === "running";
        this.consumeAsyncCommandOutput(snapshot, output, options);
      }
      remoteMayBeRunning = false;

      if (snapshot.status === "cancelled") {
        throw new DomainError(
          "mesh_execution_aborted",
          snapshot.error?.message ?? "The asynchronous mesh command was cancelled.",
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
      return snapshot.result;
    } catch (error) {
      if (jobId && remoteMayBeRunning) {
        try {
          const cancelled = await this.sendAsyncCommandRequest({
            action: "cancel",
            jobId,
            stdoutOffset: output.stdout.length,
            stderrOffset: output.stderr.length,
          });
          this.consumeAsyncCommandOutput(cancelled, output, options);
          remoteMayBeRunning = cancelled.status === "running";
          if (remoteMayBeRunning) {
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
            throw error;
          }
          throw new DomainError(
            options.signal?.aborted
              ? "mesh_execution_aborted"
              : "mesh_execution_unreachable",
            options.signal?.aborted
              ? "The asynchronous mesh command was aborted, but remote cancellation could not be confirmed."
              : "The asynchronous mesh command failed, but remote cancellation could not be confirmed.",
            { cause: cancelError },
          );
        }
      }
      throw error;
    }
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
    signal?: AbortSignal,
    requestIdOverride?: string,
  ): Promise<MeshExecutionAsyncCommandSnapshot> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal?.aborted) {
        throw new DomainError("mesh_execution_aborted", "The mesh execution request was aborted.");
      }
      await this.ensureSession();
      const session = this.session;
      const endpoint = this.endpoint;
      if (!session || !endpoint) {
        throw new DomainError("mesh_execution_session_invalid", "The mesh execution session is unavailable.");
      }
      const requestId = requestIdOverride ?? crypto.randomUUID();
      const request: MeshExecutionAsyncCommandRequest = {
        protocolVersion: MESH_EXECUTION_PROTOCOL_VERSION,
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        requestId,
        ...operation,
      };
      try {
        const response = await this.post(
          resolveMeshRoute(endpoint, "api/mesh/internal/execution/async"),
          request,
          {
            "x-clanky-mesh-session-id": session.sessionId,
            "x-clanky-mesh-request-id": requestId,
          },
          signal,
          MESH_EXECUTION_ASYNC_REQUEST_TIMEOUT_MS,
        );
        const body = parseResponseShape<MeshRpcResponse>(
          response,
          ["protocolVersion", "requestId", "encryptedPayload"],
          "The mesh asynchronous command response is invalid.",
        );
        if (body.protocolVersion !== MESH_EXECUTION_PROTOCOL_VERSION || body.requestId !== requestId) {
          throw new DomainError(
            "mesh_execution_response_invalid",
            "The mesh asynchronous command response does not match the request.",
          );
        }
        return parseAsyncCommandSnapshot(await decryptMeshPayload(body.encryptedPayload));
      } catch (error) {
        if (
          attempt === 0
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

  async listDirectory(path: string, options?: { includeHidden?: boolean }): Promise<string[]> {
    return await this.execute<string[]>({
      operation: "listDirectory",
      path,
      includeHidden: options?.includeHidden,
    });
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

  async writeFileStream(
    path: string,
    stream: ReadableStream<Uint8Array>,
    options?: FileWriteStreamOptions,
  ): Promise<FileWriteStreamResult> {
    if (options?.signal?.aborted) {
      throw new DomainError("mesh_execution_aborted", "The mesh execution request was aborted.");
    }
    await this.ensureSession();
    const session = this.session;
    const endpoint = this.endpoint;
    if (!session || !endpoint) {
      throw new DomainError("mesh_execution_session_invalid", "The mesh execution session is unavailable.");
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const abortHandler = () => controller.abort();
    options?.signal?.addEventListener("abort", abortHandler, { once: true });
    this.activeRequestControllers.add(controller);
    try {
      const url = new URL(resolveMeshRoute(endpoint, "api/mesh/internal/execution/file"));
      url.searchParams.set("path", path);
      url.searchParams.set("append", options?.append ? "1" : "0");
      if (options?.expectedOffset !== undefined) {
        url.searchParams.set("expectedOffset", String(options.expectedOffset));
      }
      if (options?.maxBytes !== undefined) {
        url.searchParams.set("maxBytes", String(options.maxBytes));
      }

      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/octet-stream",
          "x-clanky-mesh-session-id": session.sessionId,
          "x-clanky-mesh-session-token": session.sessionToken,
        },
        body: stream,
        signal: controller.signal,
        tls: this.workerTls,
      });
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
        if (error.code === "mesh_execution_aborted") {
          this.closeSession();
        }
        throw error;
      }
      if (options?.signal?.aborted) {
        this.closeSession();
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
  }

  async streamFile(path: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array> | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal?.aborted) {
        throw new DomainError("mesh_execution_aborted", "The mesh execution request was aborted.");
      }
      await this.ensureSession();
      const session = this.session;
      const endpoint = this.endpoint;
      if (!session || !endpoint) {
        throw new DomainError("mesh_execution_session_invalid", "The mesh execution session is unavailable.");
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      const abortHandler = () => controller.abort();
      signal?.addEventListener("abort", abortHandler, { once: true });
      try {
        const url = new URL(resolveMeshRoute(endpoint, "api/mesh/internal/execution/file"));
        url.searchParams.set("path", path);
        const response = await this.fetchImpl(url, {
          method: "GET",
          headers: {
            accept: "application/octet-stream",
            "x-clanky-mesh-session-id": session.sessionId,
            "x-clanky-mesh-session-token": session.sessionToken,
          },
          signal: controller.signal,
          tls: this.workerTls,
        });
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", abortHandler);

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

        this.activeStreamControllers.add(controller);
        return this.wrapFileStream(response.body, controller, signal);
      } catch (error) {
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", abortHandler);
        if (error instanceof DomainError) {
          if (error.code === "mesh_execution_aborted") {
            this.closeSession();
          }
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
    signal?: AbortSignal,
  ): ReadableStream<Uint8Array> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
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
    };
    const abortHandler = () => {
      void reader?.cancel().catch(() => undefined);
      controller.abort();
    };
    const controllerAbortHandler = () => {
      void reader?.cancel().catch(() => undefined);
    };
    signal?.addEventListener("abort", abortHandler, { once: true });
    controller.signal.addEventListener("abort", controllerAbortHandler, { once: true });

    return new ReadableStream<Uint8Array>({
      start() {
        reader = stream.getReader();
      },
      async pull(outputController) {
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
          if (done) {
            outputController.close();
            cleanup();
            return;
          }
          outputController.enqueue(value);
        } catch (error) {
          if (signal?.aborted) {
            outputController.error(new DomainError("mesh_execution_aborted", "The mesh execution request was aborted.", {
              cause: error,
            }));
          } else {
            outputController.error(error);
          }
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
  }

  private async execute<T>(
    operation: Omit<MeshExecutionRpcRequest, "protocolVersion" | "sessionId" | "sessionToken" | "requestId" | "operation">
      & { operation: MeshExecutionRpcRequest["operation"] },
    signal?: AbortSignal,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal?.aborted) {
        throw new DomainError("mesh_execution_aborted", "The mesh execution request was aborted.");
      }
      await this.ensureSession();
      const session = this.session;
      const endpoint = this.endpoint;
      if (!session || !endpoint) {
        throw new DomainError("mesh_execution_session_invalid", "The mesh execution session is unavailable.");
      }
      const requestId = crypto.randomUUID();
      const request: MeshExecutionRpcRequest = {
        protocolVersion: MESH_EXECUTION_PROTOCOL_VERSION,
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        requestId,
        ...operation,
      };
      try {
        const response = await this.post(
          resolveMeshRoute(endpoint, "api/mesh/internal/execution/rpc"),
          request,
          {
            "x-clanky-mesh-session-id": session.sessionId,
            "x-clanky-mesh-request-id": requestId,
          },
          signal,
          request.operation === "exec" && request.timeout !== undefined && request.timeout !== null
            ? Math.max(this.requestTimeoutMs, request.timeout + 1_000)
            : undefined,
        );
        const body = parseResponseShape<MeshRpcResponse>(
          response,
          ["protocolVersion", "requestId", "encryptedPayload"],
          "The mesh execution RPC response is invalid.",
        );
        if (body.protocolVersion !== MESH_EXECUTION_PROTOCOL_VERSION || body.requestId !== requestId) {
          throw new DomainError("mesh_execution_response_invalid", "The mesh execution RPC response does not match the request.");
        }
        return await decryptMeshPayload(body.encryptedPayload) as T;
      } catch (error) {
        if (error instanceof DomainError && error.code === "mesh_execution_aborted") {
          this.closeSession();
        }
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
    }

    throw new DomainError("mesh_execution_session_invalid", "The mesh execution session is unavailable.");
  }

  closeSession(): void {
    this.sessionGeneration += 1;
    for (const controller of this.activeStreamControllers) {
      controller.abort();
    }
    this.activeStreamControllers.clear();
    for (const controller of this.activeRequestControllers) {
      controller.abort();
    }
    this.activeRequestControllers.clear();
    this.session = null;
    this.endpoint = null;
    this.workerTls = undefined;
  }

  private async ensureSession(): Promise<void> {
    if (!this.session || this.session.expiresAt <= Date.now()) {
      await this.openSession();
    }
  }

  private async post(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    signal?: AbortSignal,
    requestTimeoutMs?: number,
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
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        tls: this.workerTls,
      });
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
      if (error instanceof DomainError) throw error;
      if (signal?.aborted) {
        throw new DomainError("mesh_execution_aborted", "The mesh execution request was aborted.", { cause: error });
      }
      throw new DomainError("mesh_execution_unreachable", "The selected mesh execution peer could not be reached.", {
        cause: error,
      });
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abortHandler);
    }
  }
}
