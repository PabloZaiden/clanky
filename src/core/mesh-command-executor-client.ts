/**
 * HTTP client for signed, encrypted mesh CommandExecutor sessions.
 */

import type {
  MeshExecutionRpcRequest,
  MeshExecutionSessionRequest,
} from "@/contracts/schemas/mesh-execution";
import {
  MESH_EXECUTION_CHANNEL,
  MESH_ACP_CHANNEL,
  MESH_EXECUTION_PROTOCOL_VERSION,
  MESH_EXECUTION_DEFAULT_TIMEOUT_MS,
  MESH_EXECUTION_SESSION_REQUEST_TIMEOUT_MS,
  MESH_EXECUTION_SESSION_REQUEST_TTL_MS,
  MESH_ACP_SESSION_TTL_MS,
} from "@/shared/mesh-execution";
import {
  getMeshNode,
  getMeshLinkForLocalUser,
  listMeshLinkMembers,
} from "../persistence/mesh";
import {
  ensureLocalMeshNodeIdentity,
  signMeshPayload,
} from "../persistence/mesh-node-identity";
import { decryptMeshPayload } from "./mesh-payload-crypto";
import { buildMeshExecutionSessionSigningPayload } from "./mesh-protocol";
import { resolveMeshRoute } from "./mesh-transport-config";
import { DomainError } from "./domain-error";
import { requireCurrentUserId } from "./user-context";
import type {
  CommandOptions,
  CommandResult,
} from "./command-executor";

export interface MeshCommandExecutorClientConfig {
  workspaceId: string;
  directory: string;
  executionNodeId: string;
  localUserId?: string;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  channel?: typeof MESH_EXECUTION_CHANNEL | typeof MESH_ACP_CHANNEL;
  sessionTtlMs?: number;
}

export interface MeshExecutionSessionConnection {
  endpoint: string;
  sessionId: string;
  sessionToken: string;
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

export class MeshCommandExecutorClient {
  private readonly workspaceId: string;
  private readonly directory: string;
  private readonly executionNodeId: string;
  private readonly localUserId?: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly channel: typeof MESH_EXECUTION_CHANNEL | typeof MESH_ACP_CHANNEL;
  private readonly sessionTtlMs: number;
  private session: MeshExecutionSession | null = null;
  private endpoint: string | null = null;

  constructor(config: MeshCommandExecutorClientConfig) {
    this.workspaceId = config.workspaceId;
    this.directory = config.directory;
    this.executionNodeId = config.executionNodeId;
    this.localUserId = config.localUserId;
    this.requestTimeoutMs = config.requestTimeoutMs ?? MESH_EXECUTION_DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    this.channel = config.channel ?? MESH_EXECUTION_CHANNEL;
    this.sessionTtlMs = config.sessionTtlMs
      ?? (this.channel === MESH_ACP_CHANNEL
        ? MESH_ACP_SESSION_TTL_MS
        : MESH_EXECUTION_SESSION_REQUEST_TTL_MS);
  }

  async openSession(): Promise<void> {
    this.closeSession();
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
    const link = await getMeshLinkForLocalUser(localUserId);
    if (!link) {
      throw new DomainError("mesh_link_not_found", "The workspace owner mesh link was not found.");
    }

    if (link.status !== "active" || link.activeNodeId !== identity.nodeId) {
      throw new DomainError(
        "mesh_execution_owner_unavailable",
        "The local mesh node is not the active mesh node.",
      );
    }

    const member = (await listMeshLinkMembers(link.linkId))
      .find((candidate) => candidate.nodeId === this.executionNodeId);
    const node = await getMeshNode(this.executionNodeId);
    const endpoint = member?.endpoint ?? node?.endpoint;
    if (!member || !node || member.status !== "active" || node.status !== "active" || !endpoint) {
      throw new DomainError(
        "mesh_execution_endpoint_unavailable",
        "The workspace execution owner has no usable mesh endpoint.",
      );
    }

    const channel = this.channel;
    const expiresAt = new Date(Date.now() + this.sessionTtlMs).toISOString();
    const unsigned: Omit<MeshExecutionSessionRequest, "signature"> = {
      protocolVersion: MESH_EXECUTION_PROTOCOL_VERSION,
      requestId: crypto.randomUUID(),
      linkId: link.linkId,
      callerNodeId: identity.nodeId,
      callerPublicKey: identity.publicKey,
      callerFingerprint: identity.fingerprint,
      callerEncryptionPublicKey: identity.encryptionPublicKey,
      targetNodeId: this.executionNodeId,
      workspaceId: this.workspaceId,
      directory: this.directory,
      channel,
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
    };
  }



  async exec(
    command: string,
    args: string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    const result = await this.execute<CommandResult>({
      operation: "exec",
      command,
      args,
      cwd: options?.cwd,
      timeout: options?.timeout,
      env: options?.env,
    }, options?.signal);
    if (result.stdout) options?.onStdoutChunk?.(result.stdout);
    if (result.stderr) options?.onStderrChunk?.(result.stderr);
    return result;
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

  private async execute<T>(
    operation: Omit<MeshExecutionRpcRequest, "protocolVersion" | "sessionId" | "sessionToken" | "requestId" | "operation">
      & { operation: MeshExecutionRpcRequest["operation"] },
    signal?: AbortSignal,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
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
            || error.code === "mesh_execution_authority_changed"
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
    this.session = null;
    this.endpoint = null;
  }

  private async ensureSession(): Promise<void> {
    if (!this.session || this.session.expiresAt <= Date.now()) {
      this.closeSession();
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
      throw new DomainError("mesh_execution_unreachable", "The mesh execution owner could not be reached.", {
        cause: error,
      });
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abortHandler);
    }
  }
}
