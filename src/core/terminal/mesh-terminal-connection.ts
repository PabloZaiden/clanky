/**
 * Owner-side Mesh interactive terminal connection.
 */

import type {
  MeshTerminalServerFrame,
  MeshTerminalSessionRequest,
} from "@/contracts/schemas/mesh-terminal";
import { MeshTerminalServerFrameSchema } from "@/contracts/schemas/mesh-terminal";
import {
  MESH_TERMINAL_CAPABILITY,
  MESH_TERMINAL_MAX_FRAME_BYTES,
  MESH_TERMINAL_MAX_INPUT_BYTES,
  MESH_TERMINAL_PROTOCOL_VERSION,
  MESH_TERMINAL_SESSION_REQUEST_TIMEOUT_MS,
  MESH_TERMINAL_SESSION_REQUEST_TTL_MS,
  MESH_TERMINAL_WEBSOCKET_OPEN_TIMEOUT_MS,
} from "@/shared/mesh-terminal";
import type { AgentProvider } from "@/shared/settings";
import type { TerminalConnectionMode } from "@/shared/terminal-session";
import {
  getMeshLinkForLocalUser,
  getMeshNode,
  listMeshLinkMembers,
} from "../../persistence/mesh";
import {
  ensureLocalMeshNodeIdentity,
  signMeshPayload,
} from "../../persistence/mesh-node-identity";
import { encryptMeshPayload, decryptMeshPayload } from "../mesh-payload-crypto";
import { buildMeshTerminalSessionSigningPayload } from "../mesh-terminal-protocol";
import { resolveMeshRoute } from "../mesh-transport-config";
import { requireCurrentUserId } from "../user-context";
import { DomainError } from "../domain-error";
import type {
  InteractiveTerminalCallbacks,
  InteractiveTerminalConnection,
  InteractiveTerminalConnectResult,
} from "./interactive-terminal-connection";
import { isDomainError } from "../domain-error";

interface MeshTerminalSessionResponse {
  protocolVersion: typeof MESH_TERMINAL_PROTOCOL_VERSION;
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
  endpoint: string;
  sessionId: string;
  sessionToken: string;
  expiresAt: number;
}

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

function toWebSocketUrl(url: string): string {
  return url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

function createWebSocket(url: string, headers: Record<string, string>): WebSocket {
  const BunWebSocket = WebSocket as unknown as {
    new (url: string | URL, options?: { headers?: Record<string, string> }): WebSocket;
  };
  return new BunWebSocket(url, { headers });
}

export class MeshInteractiveTerminalConnection implements InteractiveTerminalConnection {
  private readonly fetchImpl: typeof globalThis.fetch;
  private socket: WebSocket | null = null;
  private connectPromise: Promise<InteractiveTerminalConnectResult> | null = null;
  private disposePromise: Promise<void> | null = null;
  private sessionRequestController: AbortController | null = null;
  private disposed = false;
  private closing = false;
  private ready = false;
  private receivedExit = false;
  private readyResolve: ((result: InteractiveTerminalConnectResult) => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private runtimeEnvironment?: Record<string, string>;
  private allowPersistentSessionCreate: boolean;
  private persistentAttachRetried = false;

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
      activeMeshTerminalConnections.delete(this);
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
    if (this.disposed || this.closing) {
      throw new DomainError("mesh_terminal_connection_closed", "The Mesh terminal connection was closed while connecting.");
    }
    const websocketUrl = toWebSocketUrl(
      resolveMeshRoute(session.endpoint, "api/mesh/internal/terminal"),
    );
    const socket = createWebSocket(websocketUrl, {
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
    this.socket = null;
    activeMeshTerminalConnections.delete(this);
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: "terminal.close" }));
      } catch {
        // The socket is already unavailable.
      }
    }
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close(1000, "Terminal disconnected");
    }
  }

  private async openSession(): Promise<OpenMeshTerminalSession> {
    const identity = await ensureLocalMeshNodeIdentity();
    if (!identity.encryptionPublicKey) {
      throw new DomainError("mesh_terminal_encryption_unavailable", "The local Mesh identity has no encryption key.");
    }
    const localUserId = this.config.localUserId ?? requireCurrentUserId();
    const link = await getMeshLinkForLocalUser(localUserId);
    if (!link || link.status !== "active") {
      throw new DomainError("mesh_terminal_link_unavailable", "The local Mesh link is unavailable.");
    }
    const member = (await listMeshLinkMembers(link.linkId))
      .find((candidate) => candidate.nodeId === this.config.executionNodeId);
    const node = await getMeshNode(this.config.executionNodeId);
    const endpoint = member?.endpoint ?? node?.endpoint;
    if (
      !member
      || member.status !== "active"
      || !node
      || node.status !== "active"
      || !node.encryptionPublicKey
      || !endpoint
    ) {
      throw new DomainError(
        "mesh_terminal_target_unavailable",
        "The selected workspace execution peer cannot accept terminal sessions.",
      );
    }
    const expiresAt = new Date(Date.now() + MESH_TERMINAL_SESSION_REQUEST_TTL_MS).toISOString();
    const unsigned: Omit<MeshTerminalSessionRequest, "signature"> = {
      protocolVersion: MESH_TERMINAL_PROTOCOL_VERSION,
      capability: MESH_TERMINAL_CAPABILITY,
      requestId: crypto.randomUUID(),
      linkId: link.linkId,
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
              node.encryptionPublicKey,
            ),
          }
        : {}),
      nonce: crypto.randomUUID(),
      expiresAt,
    };
    const request: MeshTerminalSessionRequest = {
      ...unsigned,
      signature: await signMeshPayload(buildMeshTerminalSessionSigningPayload(unsigned)),
    };
    const route = resolveMeshRoute(endpoint, "api/mesh/internal/terminal/session");
    const response = await this.post(route, request, {
      "x-clanky-mesh-node-id": identity.nodeId,
      "x-clanky-mesh-request-id": request.requestId,
    });
    if (response.protocolVersion !== MESH_TERMINAL_PROTOCOL_VERSION) {
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
      endpoint,
      sessionId: response.sessionId,
      sessionToken,
      expiresAt: expiresAtMs,
    };
  }

  private async post(
    url: string,
    body: MeshTerminalSessionRequest,
    headers: Record<string, string>,
  ): Promise<MeshTerminalSessionResponse> {
    const controller = new AbortController();
    this.sessionRequestController = controller;
    const timer = setTimeout(() => controller.abort(), MESH_TERMINAL_SESSION_REQUEST_TIMEOUT_MS);
    timer.unref?.();
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

  private async waitForSocketOpen(socket: WebSocket): Promise<void> {
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
