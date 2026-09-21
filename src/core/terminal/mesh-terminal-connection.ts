/**
 * Owner-side Mesh interactive terminal connection.
 */

import type {
  MeshTerminalServerFrame,
  MeshTerminalSessionCloseRequest,
  MeshTerminalSessionRequest,
} from "@/contracts/schemas/mesh-terminal";
import { MeshTerminalServerFrameSchema } from "@/contracts/schemas/mesh-terminal";
import {
  MESH_TERMINAL_CAPABILITY,
  MESH_TERMINAL_MAX_FRAME_BYTES,
  MESH_TERMINAL_MAX_INPUT_BYTES,
  MESH_TERMINAL_SESSION_REQUEST_TIMEOUT_MS,
  MESH_TERMINAL_SESSION_REQUEST_TTL_MS,
  MESH_TERMINAL_WEBSOCKET_OPEN_TIMEOUT_MS,
  type MeshTerminalProtocolVersion,
} from "@/shared/mesh-terminal";
import { MESH_PROTOCOL_VERSION } from "@/shared/mesh-protocol";
import type { AgentProvider } from "@/shared/settings";
import type { TerminalConnectionMode } from "@/shared/terminal-session";
import type { MeshPeerRoute } from "@/shared/mesh";
import { createLogger } from "@pablozaiden/webapp/server";
import { getWorkerRegistration } from "../../persistence/mesh";
import {
  ensureLocalMeshNodeIdentity,
  signMeshPayload,
} from "../../persistence/mesh-node-identity";
import { encryptMeshPayload, decryptMeshPayload } from "../mesh-payload-crypto";
import { buildMeshTerminalSessionSigningPayload } from "../mesh-terminal-protocol";
import { MeshRelayStreamError } from "../mesh-relay-errors";
import {
  openMeshPeerSocket,
  requestMeshPeer,
  type MeshDuplexSocket,
} from "../mesh-peer-transport";
import { requireCurrentUserId } from "../../context/user-context";
import { DomainError } from "../../domain/domain-error";
import type {
  InteractiveTerminalCallbacks,
  InteractiveTerminalConnection,
  InteractiveTerminalConnectResult,
} from "./interactive-terminal-connection";
import { isDomainError } from "../../domain/domain-error";

interface MeshTerminalSessionResponse {
  protocolVersion: MeshTerminalProtocolVersion;
  capability: typeof MESH_TERMINAL_CAPABILITY;
  sessionId: string;
  expiresAt: string;
  encryptedPayload: unknown;
}

export interface MeshTerminalConnectionConfig {
  workspaceId: string;
  executionRoot: string;
  directory: string;
  executionNodeId: string;
  provider: AgentProvider;
  terminalSessionId: string;
  remoteSessionName: string;
  connectionMode: TerminalConnectionMode;
  useTmux: boolean;
  allowPersistentSessionCreate: boolean;
  environment?: Record<string, string>;
  callbacks: InteractiveTerminalCallbacks;
  localUserId?: string;
  fetch?: typeof globalThis.fetch;
  onPersistentSessionAttachUnavailable?: () => Promise<{
    environment?: Record<string, string>;
    notice?: string;
  }>;
}

interface OpenMeshTerminalSession {
  route: MeshPeerRoute;
  sessionId: string;
  sessionToken: string;
  protocolVersion: MeshTerminalProtocolVersion;
  expiresAt: number;
}

const log = createLogger("core:mesh-terminal-connection");
const RELEASE_RETRY_MIN_MS = 1_000;
const RELEASE_RETRY_MAX_MS = 30_000;
const MAX_RELEASE_RETRY_ATTEMPTS = 5;
const activeMeshTerminalConnections = new Set<MeshInteractiveTerminalConnection>();

export async function closeAllMeshTerminalConnections(): Promise<void> {
  await Promise.all([...activeMeshTerminalConnections].map(
    async (connection) => await connection.dispose(),
  ));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("mesh_terminal_response_invalid", "The Mesh terminal response is invalid.");
  }
  return value as Record<string, unknown>;
}

export class MeshInteractiveTerminalConnection implements InteractiveTerminalConnection {
  private readonly fetchImpl: typeof globalThis.fetch;
  private socket: MeshDuplexSocket | null = null;
  private connectPromise: Promise<InteractiveTerminalConnectResult> | null = null;
  private disposePromise: Promise<void> | null = null;
  private sessionRequestController: AbortController | null = null;
  private session: OpenMeshTerminalSession | null = null;
  private disposed = false;
  private closing = false;
  private ready = false;
  private receivedExit = false;
  private readyResolve: ((result: InteractiveTerminalConnectResult) => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private runtimeEnvironment?: Record<string, string>;
  private allowPersistentSessionCreate: boolean;
  private persistentAttachRetried = false;
  private releaseRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private releaseRetryAttempts = 0;

  constructor(private readonly config: MeshTerminalConnectionConfig) {
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    this.runtimeEnvironment = config.environment;
    this.allowPersistentSessionCreate = config.allowPersistentSessionCreate;
  }

  async connect(): Promise<InteractiveTerminalConnectResult> {
    if (this.disposed) {
      throw new DomainError("mesh_terminal_connection_closed", "The Mesh terminal connection is closed.");
    }
    if (this.ready) {
      return { runtimeConnectionMode: this.config.connectionMode };
    }
    if (this.connectPromise) {
      return await this.connectPromise;
    }
    const pending = this.connectInternal();
    this.connectPromise = pending;
    activeMeshTerminalConnections.add(this);
    try {
      return await pending;
    } catch (error) {
      if (this.session) {
        activeMeshTerminalConnections.add(this);
      } else {
        activeMeshTerminalConnections.delete(this);
      }
      throw error;
    } finally {
      if (this.connectPromise === pending) {
        this.connectPromise = null;
      }
    }
  }

  private async connectInternal(): Promise<InteractiveTerminalConnectResult> {
    if (this.disposed) {
      throw new DomainError("mesh_terminal_connection_closed", "The Mesh terminal connection is closed.");
    }
    this.persistentAttachRetried = false;
    try {
      return await this.connectOnce();
    } catch (error) {
      if (
        this.disposed
        || (
          !isDomainError(error)
          || error.code !== "terminal_persistent_session_attach_unavailable"
          || this.persistentAttachRetried
        )
      ) {
        throw error;
      }
      const recovery = await this.config.onPersistentSessionAttachUnavailable?.();
      if (!recovery) {
        throw error;
      }
      this.persistentAttachRetried = true;
      this.runtimeEnvironment = recovery.environment;
      this.allowPersistentSessionCreate = true;
      this.closing = false;
      this.receivedExit = false;
      return await this.connectOnce(recovery.notice);
    }
  }

  private async connectOnce(recoveryNotice?: string): Promise<InteractiveTerminalConnectResult> {
    if (this.disposed) {
      throw new DomainError("mesh_terminal_connection_closed", "The Mesh terminal connection is closed.");
    }
    this.closing = false;
    this.receivedExit = false;
    const session = await this.openSession();
    this.session = session;
    if (this.disposed || this.closing) {
      try {
        await this.releaseSessionBeforeSocket(session);
        if (this.session === session) {
          this.session = null;
        }
      } catch (error) {
        activeMeshTerminalConnections.add(this);
        this.scheduleReleaseRetry();
        throw error;
      }
      throw new DomainError("mesh_terminal_connection_closed", "The Mesh terminal connection was closed while connecting.");
    }
    const socket = openMeshPeerSocket(session.route, "api/mesh/internal/terminal", {
      "x-clanky-mesh-session-id": session.sessionId,
      "x-clanky-mesh-session-token": session.sessionToken,
    });
    this.socket = socket;
    const readyPromise = new Promise<InteractiveTerminalConnectResult>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    void readyPromise.catch(() => undefined);
    socket.onmessage = (event: MessageEvent) => {
      void this.handleMessage(event.data);
    };
    socket.onerror = () => {
      this.rejectReady(new DomainError(
        "mesh_terminal_connection_failed",
        "The Mesh terminal WebSocket failed.",
      ));
    };
    socket.onclose = () => {
      const isCurrentSocket = this.socket === socket;
      this.ready = false;
      if (isCurrentSocket) {
        this.socket = null;
      }
      if (!isCurrentSocket) {
        return;
      }
      activeMeshTerminalConnections.delete(this);
      if (!this.closing) {
        if (this.receivedExit) {
          return;
        }
        const error = new DomainError(
          "mesh_terminal_connection_closed",
          "The Mesh terminal WebSocket closed.",
        );
        this.rejectReady(error);
        this.config.callbacks.onError?.(error);
        this.config.callbacks.onExit?.(null, null);
      }
    };
    try {
      await this.waitForSocketOpen(socket);
    } catch (error) {
      this.closing = true;
      this.rejectReady(error instanceof Error ? error : new Error(String(error)));
      if (socket.readyState !== WebSocket.CLOSED) {
        socket.close(1000, "Terminal connection failed");
      }
      throw error;
    }
    if (this.disposed || this.closing || this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
      if (socket.readyState !== WebSocket.CLOSED) {
        socket.close(1000, "Terminal disconnected");
      }
      this.rejectReady(new DomainError(
        "mesh_terminal_connection_closed",
        "The Mesh terminal WebSocket closed before the terminal became ready.",
      ));
    }
    const result = await readyPromise;
    return recoveryNotice
      ? { ...result, notice: recoveryNotice }
      : result;
  }

  sendInput(data: string): void {
    if (Buffer.byteLength(data, "utf8") > MESH_TERMINAL_MAX_INPUT_BYTES) {
      throw new DomainError("mesh_terminal_input_too_large", "The terminal input exceeds the Mesh frame limit.");
    }
    this.sendFrame({ type: "terminal.input", data });
  }

  async resize(cols: number, rows: number): Promise<void> {
    this.sendFrame({
      type: "terminal.resize",
      cols: Math.max(2, Math.min(10_000, Math.floor(cols))),
      rows: Math.max(1, Math.min(10_000, Math.floor(rows))),
    });
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) {
      return await this.disposePromise;
    }
    this.clearReleaseRetryTimer();
    const pending = this.disposeInternal();
    this.disposePromise = pending;
    try {
      await pending;
    } finally {
      if (this.disposePromise === pending) {
        this.disposePromise = null;
      }
    }
  }

  private async disposeInternal(): Promise<void> {
    this.disposed = true;
    this.closing = true;
    this.ready = false;
    this.sessionRequestController?.abort();
    this.sessionRequestController = null;
    this.rejectReady(new DomainError("mesh_terminal_connection_closed", "The Mesh terminal connection was closed."));
    const socket = this.socket;
    const session = this.session;
    this.socket = null;
    let releaseError: unknown;
    let releaseFailed = false;
    if (session) {
      try {
        await this.releaseSessionWithFallback(session, socket);
        if (this.session === session) {
          this.session = null;
        }
        this.releaseRetryAttempts = 0;
      } catch (error) {
        releaseFailed = true;
        releaseError = error;
      }
    }
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      try {
        socket.close(1000, "Terminal disconnected");
      } catch (error) {
        if (!releaseFailed) {
          releaseFailed = true;
          releaseError = error;
        }
      }
    }
    if (!this.session) {
      this.clearReleaseRetryTimer();
      activeMeshTerminalConnections.delete(this);
    }
    if (releaseFailed) {
      if (this.session) {
        this.scheduleReleaseRetry();
      }
      throw releaseError;
    }
  }

  private scheduleReleaseRetry(): void {
    if (!this.session || this.releaseRetryTimer !== undefined) {
      return;
    }
    if (this.releaseRetryAttempts >= MAX_RELEASE_RETRY_ATTEMPTS) {
      activeMeshTerminalConnections.delete(this);
      log.error("Failed to release the Mesh terminal session after retries", {
        sessionId: this.session.sessionId,
        attempts: this.releaseRetryAttempts,
      });
      return;
    }
    const delayMs = Math.min(
      RELEASE_RETRY_MIN_MS * (2 ** this.releaseRetryAttempts),
      RELEASE_RETRY_MAX_MS,
    );
    this.releaseRetryAttempts += 1;
    this.releaseRetryTimer = setTimeout(() => {
      this.releaseRetryTimer = undefined;
      void this.dispose().catch((error: Error) => {
        log.warn("Mesh terminal session release retry failed", {
          sessionId: this.session?.sessionId,
          attempt: this.releaseRetryAttempts,
          error: String(error),
        });
      });
    }, delayMs);
    this.releaseRetryTimer.unref?.();
  }

  private clearReleaseRetryTimer(): void {
    if (this.releaseRetryTimer !== undefined) {
      clearTimeout(this.releaseRetryTimer);
      this.releaseRetryTimer = undefined;
    }
  }

  private async openSession(): Promise<OpenMeshTerminalSession> {
    const identity = await ensureLocalMeshNodeIdentity();
    if (!identity.encryptionPublicKey) {
      throw new DomainError("mesh_terminal_encryption_unavailable", "The local Mesh identity has no encryption key.");
    }
    const localUserId = this.config.localUserId ?? requireCurrentUserId();
    const registration = await getWorkerRegistration(
      this.config.executionNodeId,
      localUserId,
    );
    if (
      !registration
      || registration.grantStatus !== "active"
      || !registration.workerEncryptionPublicKey
    ) {
      throw new DomainError(
        "mesh_terminal_target_unavailable",
        "The selected workspace execution peer cannot accept terminal sessions.",
      );
    }
    const peerRoute = registration.route;
    const protocolVersion: MeshTerminalProtocolVersion = MESH_PROTOCOL_VERSION;
    const expiresAt = new Date(Date.now() + MESH_TERMINAL_SESSION_REQUEST_TTL_MS).toISOString();
    const buildRequest = async (): Promise<MeshTerminalSessionRequest> => {
      const unsigned: Omit<MeshTerminalSessionRequest, "signature"> = {
        protocolVersion,
        capability: MESH_TERMINAL_CAPABILITY,
        requestId: crypto.randomUUID(),
        callerNodeId: identity.nodeId,
        callerPublicKey: identity.publicKey,
        callerFingerprint: identity.fingerprint,
        callerEncryptionPublicKey: identity.encryptionPublicKey,
        targetNodeId: this.config.executionNodeId,
        workspaceId: this.config.workspaceId,
        executionRoot: this.config.executionRoot,
        directory: this.config.directory,
        provider: this.config.provider,
        terminalSessionId: this.config.terminalSessionId,
        remoteSessionName: this.config.remoteSessionName,
        connectionMode: this.config.connectionMode,
        useTmux: this.config.useTmux,
        allowPersistentSessionCreate: this.allowPersistentSessionCreate,
        ...(this.runtimeEnvironment
          ? {
              encryptedEnvironment: encryptMeshPayload(
                this.runtimeEnvironment,
                registration.workerEncryptionPublicKey,
              ),
            }
          : {}),
        nonce: crypto.randomUUID(),
        expiresAt,
      };
      return {
        ...unsigned,
        signature: await signMeshPayload(buildMeshTerminalSessionSigningPayload(unsigned)),
      };
    };
    const request = await buildRequest();
    const response = await this.post(peerRoute, "api/mesh/internal/terminal/session", request, {
      "x-clanky-mesh-node-id": identity.nodeId,
      "x-clanky-mesh-request-id": request.requestId,
    });
    if (response.protocolVersion !== protocolVersion) {
      throw new DomainError("mesh_terminal_protocol_mismatch", "The Mesh peer uses an unsupported terminal protocol.");
    }
    if (response.capability !== MESH_TERMINAL_CAPABILITY) {
      throw new DomainError("mesh_terminal_capability_mismatch", "The Mesh peer does not support terminal-v1.");
    }
    const decrypted = asRecord(await decryptMeshPayload(response.encryptedPayload));
    const sessionToken = decrypted["sessionToken"];
    if (typeof sessionToken !== "string" || sessionToken.length < 32) {
      throw new DomainError("mesh_terminal_response_invalid", "The Mesh terminal session token is invalid.");
    }
    const expiresAtMs = new Date(response.expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new DomainError("mesh_terminal_session_expired", "The Mesh terminal session has expired.");
    }
    return {
      route: peerRoute,
      sessionId: response.sessionId,
      sessionToken,
      protocolVersion,
      expiresAt: expiresAtMs,
    };
  }

  private async post(
    route: MeshPeerRoute,
    path: string,
    body: MeshTerminalSessionRequest,
    headers: Record<string, string>,
  ): Promise<MeshTerminalSessionResponse> {
    const controller = new AbortController();
    this.sessionRequestController = controller;
    const timer = setTimeout(() => controller.abort(), MESH_TERMINAL_SESSION_REQUEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await requestMeshPeer(route, path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        fetch: this.fetchImpl,
      });
      const payload = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const record = payload && typeof payload === "object"
          ? payload as Record<string, unknown>
          : {};
        const code = typeof record["error"] === "string"
          ? record["error"]
          : response.status === 404
            ? "mesh_terminal_capability_unavailable"
            : "mesh_terminal_session_failed";
        const message = typeof record["message"] === "string"
          ? record["message"]
          : response.status === 404
            ? "The Mesh peer does not expose terminal-v1."
            : "The Mesh terminal session request failed.";
        throw new DomainError(code, message, { details: { status: response.status } });
      }
      const record = asRecord(payload);
      if (
        typeof record["protocolVersion"] !== "number"
        || typeof record["capability"] !== "string"
        || typeof record["sessionId"] !== "string"
        || typeof record["expiresAt"] !== "string"
        || !("encryptedPayload" in record)
      ) {
        throw new DomainError("mesh_terminal_response_invalid", "The Mesh terminal response is invalid.");
      }
      return record as unknown as MeshTerminalSessionResponse;
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new DomainError("mesh_terminal_session_timeout", "The Mesh terminal session request timed out.", {
          cause: error,
        });
      }
      throw new DomainError("mesh_terminal_session_failed", "The Mesh terminal session request failed.", {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      if (this.sessionRequestController === controller) {
        this.sessionRequestController = null;
      }
    }
  }

  private async releaseSession(
    session: OpenMeshTerminalSession,
  ): Promise<boolean> {
    const request: MeshTerminalSessionCloseRequest = {
      protocolVersion: session.protocolVersion,
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      requestId: crypto.randomUUID(),
    };
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      MESH_TERMINAL_SESSION_REQUEST_TIMEOUT_MS,
    );
    timer.unref?.();
    try {
      const response = await requestMeshPeer(
        session.route,
        "api/mesh/internal/terminal/session",
        {
          method: "DELETE",
          headers: {
            "content-type": "application/json",
            "x-clanky-mesh-session-id": session.sessionId,
            "x-clanky-mesh-request-id": request.requestId,
          },
          body: JSON.stringify(request),
          signal: controller.signal,
          fetch: this.fetchImpl,
        },
      );
      if (response.status === 404 || response.status === 405) {
        return false;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as unknown;
        const record = payload && typeof payload === "object"
          ? payload as Record<string, unknown>
          : {};
        const code = typeof record["error"] === "string"
          ? record["error"]
          : "mesh_terminal_session_release_failed";
        if (
          response.status === 401
          && (
            code === "mesh_terminal_session_invalid"
            || code === "mesh_terminal_session_expired"
          )
        ) {
          return true;
        }
        throw new DomainError(
          code,
          typeof record["message"] === "string"
            ? record["message"]
            : "The Mesh terminal session could not be released.",
          { details: { status: response.status } },
        );
      }
      return true;
    } catch (error) {
      if (
        error instanceof MeshRelayStreamError
        && error.code === "mesh_relay_route_forbidden"
      ) {
        return false;
      }
      if (error instanceof DomainError) {
        throw error;
      }
      throw new DomainError(
        controller.signal.aborted
          ? "mesh_terminal_session_release_timeout"
          : "mesh_terminal_session_release_failed",
        controller.signal.aborted
          ? "Timed out releasing the Mesh terminal session."
          : "The Mesh terminal session could not be released.",
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async releaseSessionBeforeSocket(
    session: OpenMeshTerminalSession,
  ): Promise<void> {
    await this.releaseSessionWithFallback(session);
  }

  private async releaseSessionWithFallback(
    session: OpenMeshTerminalSession,
    socket?: MeshDuplexSocket | null,
  ): Promise<void> {
    if (await this.releaseSession(session)) {
      return;
    }
    const fallbackSocket = socket
      && (
        socket.readyState === WebSocket.CONNECTING
        || socket.readyState === WebSocket.OPEN
      )
      ? socket
      : openMeshPeerSocket(
      session.route,
      "api/mesh/internal/terminal",
      {
        "x-clanky-mesh-session-id": session.sessionId,
        "x-clanky-mesh-session-token": session.sessionToken,
      },
    );
    try {
      await this.waitForSocketOpen(fallbackSocket);
      fallbackSocket.send(JSON.stringify({ type: "terminal.close" }));
      await this.waitForSocketClose(fallbackSocket);
    } finally {
      if (fallbackSocket.readyState !== WebSocket.CLOSED) {
        try {
          fallbackSocket.close(1000, "Terminal disconnected");
        } catch {
          // The transport may already be closing.
        }
      }
    }
  }

  private async waitForSocketClose(socket: MeshDuplexSocket): Promise<void> {
    if (socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new DomainError(
          "mesh_terminal_session_release_timeout",
          "Timed out waiting for the Mesh terminal process to close.",
        ));
      }, MESH_TERMINAL_SESSION_REQUEST_TIMEOUT_MS);
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.removeEventListener("close", onClose);
      };
      const onClose = (): void => {
        cleanup();
        resolve();
      };
      socket.addEventListener("close", onClose);
      if (socket.readyState === WebSocket.CLOSED) {
        cleanup();
        resolve();
      }
    });
  }

  private async waitForSocketOpen(socket: MeshDuplexSocket): Promise<void> {
    if (socket.readyState === WebSocket.OPEN) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new DomainError("mesh_terminal_connection_failed", "The Mesh terminal WebSocket could not be opened."));
      };
      const onClose = () => {
        cleanup();
        reject(new DomainError("mesh_terminal_connection_closed", "The Mesh terminal WebSocket closed before opening."));
      };
      const timer = setTimeout(() => {
        cleanup();
        socket.close();
        reject(new DomainError("mesh_terminal_connection_timeout", "The Mesh terminal WebSocket open timed out."));
      }, MESH_TERMINAL_WEBSOCKET_OPEN_TIMEOUT_MS);
      timer.unref?.();
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      if (socket.readyState === WebSocket.OPEN) {
        cleanup();
        resolve();
      } else if (socket.readyState === WebSocket.CLOSED) {
        cleanup();
        reject(new DomainError(
          "mesh_terminal_connection_closed",
          "The Mesh terminal WebSocket closed before opening.",
        ));
      }
    });
  }

  private async handleMessage(value: unknown): Promise<void> {
    if (this.disposed || this.closing) {
      return;
    }
    let text: string;
    if (typeof value === "string") {
      text = value;
    } else if (value instanceof ArrayBuffer) {
      text = new TextDecoder().decode(value);
    } else if (value instanceof Blob) {
      text = await value.text();
    } else {
      this.fail(new DomainError("mesh_terminal_frame_invalid", "The Mesh terminal returned a non-text frame."));
      return;
    }
    if (Buffer.byteLength(text, "utf8") > MESH_TERMINAL_MAX_FRAME_BYTES) {
      this.fail(new DomainError("mesh_terminal_frame_too_large", "The Mesh terminal frame exceeds the size limit."));
      return;
    }
    let frame: MeshTerminalServerFrame;
    try {
      frame = MeshTerminalServerFrameSchema.parse(JSON.parse(text) as unknown);
    } catch (error) {
      this.fail(new DomainError("mesh_terminal_frame_invalid", "The Mesh terminal returned an invalid frame.", {
        cause: error,
      }));
      return;
    }
    switch (frame.type) {
      case "terminal.ready": {
        this.ready = true;
        const resolve = this.readyResolve;
        this.readyResolve = null;
        this.readyReject = null;
        resolve?.({
          runtimeConnectionMode: frame.runtimeConnectionMode,
          ...(frame.notice ? { notice: frame.notice } : {}),
        });
        return;
      }
      case "terminal.output":
        this.config.callbacks.onOutput(frame.data);
        return;
      case "terminal.clipboard":
        this.config.callbacks.onClipboardCopy?.(frame.text);
        return;
      case "terminal.exit":
        this.ready = false;
        this.receivedExit = true;
        if (this.readyResolve || this.readyReject) {
          this.rejectReady(new DomainError(
            "mesh_terminal_process_exited",
            `The remote terminal process exited with code ${String(frame.code)}.`,
          ));
        }
        this.config.callbacks.onExit?.(frame.code, frame.signal);
        return;
      case "terminal.error": {
        const error = new DomainError(
          frame.code ?? "mesh_terminal_remote_error",
          frame.message,
        );
        this.closing = true;
        this.rejectReady(error);
        this.config.callbacks.onError?.(error);
        if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
          this.socket.close(1011, "Remote terminal error");
        }
        return;
      }
      case "pong":
        return;
    }
  }

  private sendFrame(frame: { type: "terminal.input"; data: string } | {
    type: "terminal.resize";
    cols: number;
    rows: number;
  }): void {
    if (!this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new DomainError("mesh_terminal_connection_unavailable", "The Mesh terminal connection is not writable.");
    }
    const serialized = JSON.stringify(frame);
    if (Buffer.byteLength(serialized, "utf8") > MESH_TERMINAL_MAX_FRAME_BYTES) {
      throw new DomainError("mesh_terminal_frame_too_large", "The Mesh terminal frame exceeds the size limit.");
    }
    this.socket.send(serialized);
  }

  private fail(error: Error): void {
    if (this.disposed || this.closing) {
      return;
    }
    this.rejectReady(error);
    this.config.callbacks.onError?.(error);
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      this.socket.close(1003, "Invalid Mesh terminal frame");
    }
  }

  private rejectReady(error: Error): void {
    const reject = this.readyReject;
    this.readyResolve = null;
    this.readyReject = null;
    reject?.(error);
  }
}
