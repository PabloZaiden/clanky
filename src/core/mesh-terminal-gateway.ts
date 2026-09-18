/**
 * Resource-owning Mesh peer gateway for interactive terminal sessions.
 */

import { randomBytes } from "node:crypto";
import { createLogger } from "@pablozaiden/webapp/server";
import type {
  MeshTerminalClientFrame,
  MeshTerminalServerFrame,
  MeshTerminalSessionRequest,
} from "@/contracts/schemas/mesh-terminal";
import { MeshTerminalClientFrameSchema } from "@/contracts/schemas/mesh-terminal";
import {
  MESH_TERMINAL_CAPABILITY,
  MESH_TERMINAL_LEASE_CHECK_INTERVAL_MS,
  MESH_TERMINAL_MAX_CLIPBOARD_BYTES,
  MESH_TERMINAL_MAX_FRAME_BYTES,
  MESH_TERMINAL_MAX_HANDSHAKE_BYTES,
  MESH_TERMINAL_MAX_OUTPUT_BYTES,
  MESH_TERMINAL_PROTOCOL_VERSION,
  MESH_TERMINAL_SESSION_TTL_MS,
} from "@/shared/mesh-terminal";
import { getControllerGrant } from "../persistence/mesh";
import {
  ensureLocalMeshNodeIdentity,
  requireLocalMeshExecutionCapability,
  verifyMeshPayloadSignature,
} from "../persistence/mesh-node-identity";
import { decryptMeshPayload } from "./mesh-payload-crypto";
import { requireTrustedController } from "./mesh-peer-auth";
import { buildMeshTerminalSessionSigningPayload } from "./mesh-terminal-protocol";
import {
  assertPhysicalExecutionPath,
  resolveTrustedExecutionRoot,
} from "./mesh-execution-gateway";
import {
  executionPathStyleForPlatform,
  isAbsoluteExecutionPath,
} from "./execution-path";
import { getMeshWorkerDirectory } from "./mesh-runtime";
import { CommandExecutorImpl } from "./remote-command-executor";
import { DomainError, isDomainError } from "./domain-error";
import { parseManagedContextEnvironment } from "./managed-context-environment";
import { LocalTerminalConnection } from "./terminal";
import type { InteractiveTerminalConnection } from "./terminal";
import { meshInboundResourceRegistry } from "./mesh-inbound-resource-registry";

const MAX_TERMINAL_SESSIONS = 64;
const MAX_USED_NONCES = 512;
const log = createLogger("core:mesh-terminal-gateway");

export interface MeshTerminalSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface MeshTerminalLease {
  sessionId: string;
  sessionToken: string;
  callerNodeId: string;
  expiresAt: number;
  request: MeshTerminalSessionRequest;
  environment?: Record<string, string>;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

interface MeshTerminalRelay {
  socket: MeshTerminalSocket;
  connection: InteractiveTerminalConnection;
  validationTimer: ReturnType<typeof setInterval>;
}

interface UsedMeshTerminalNonce {
  expiresAt: number;
  reserved: boolean;
}

interface MeshTerminalCloseState {
  promise: Promise<void>;
  closeSocket: boolean;
  closeCode: number;
  closeReason: string;
}

export interface MeshTerminalSessionResponse {
  protocolVersion: typeof MESH_TERMINAL_PROTOCOL_VERSION;
  capability: typeof MESH_TERMINAL_CAPABILITY;
  sessionId: string;
  sessionToken: string;
  expiresAt: string;
}

export function splitUtf8(value: string, maximumBytes: number): string[] {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) {
    return [value];
  }
  const chunks: string[] = [];
  let currentChunk = "";
  let currentBytes = 0;
  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (currentChunk && currentBytes + codePointBytes > maximumBytes) {
      chunks.push(currentChunk);
      currentChunk = "";
      currentBytes = 0;
    }
    currentChunk += codePoint;
    currentBytes += codePointBytes;
  }
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  return chunks;
}

export class MeshTerminalGateway {
  private readonly leases = new Map<string, MeshTerminalLease>();
  private readonly relays = new Map<string, MeshTerminalRelay>();
  private readonly opening = new Map<string, Promise<void>>();
  private readonly openingSockets = new Map<string, MeshTerminalSocket>();
  private readonly closing = new Set<string>();
  private readonly closePromises = new Map<string, MeshTerminalCloseState>();
  private readonly usedNonces = new Map<string, UsedMeshTerminalNonce>();

  async createSession(request: MeshTerminalSessionRequest): Promise<MeshTerminalSessionResponse> {
    this.pruneExpired();
    await requireLocalMeshExecutionCapability("interactiveTerminal");
    if (Buffer.byteLength(JSON.stringify(request), "utf8") > MESH_TERMINAL_MAX_HANDSHAKE_BYTES) {
      throw new DomainError("mesh_terminal_handshake_too_large", "The Mesh terminal handshake exceeds the size limit.");
    }
    if (request.capability !== MESH_TERMINAL_CAPABILITY) {
      throw new DomainError("mesh_terminal_capability_mismatch", "The peer does not support the requested terminal capability.");
    }
    const expiresAtRequest = new Date(request.expiresAt).getTime();
    if (!Number.isFinite(expiresAtRequest) || expiresAtRequest <= Date.now()) {
      throw new DomainError("mesh_terminal_session_expired", "The Mesh terminal session request has expired.");
    }
    if (expiresAtRequest > Date.now() + MESH_TERMINAL_SESSION_TTL_MS) {
      throw new DomainError("mesh_terminal_session_expiry_invalid", "The Mesh terminal session expiry is too far in the future.");
    }
    if (this.usedNonces.has(request.nonce)) {
      throw new DomainError("mesh_terminal_replay", "The Mesh terminal session nonce has already been used.");
    }
    if (
      this.usedNonces.size >= MAX_USED_NONCES
      && ![...this.usedNonces.values()].some((entry) => !entry.reserved)
    ) {
      throw new DomainError("mesh_terminal_capacity", "The Mesh terminal nonce capacity has been reached.");
    }
    const nonceReservation: UsedMeshTerminalNonce = {
      expiresAt: expiresAtRequest,
      reserved: true,
    };
    this.usedNonces.set(request.nonce, nonceReservation);
    try {
      const { signature, ...unsigned } = request;
      if (!verifyMeshPayloadSignature(
        buildMeshTerminalSessionSigningPayload(unsigned),
        signature,
        request.callerPublicKey,
      )) {
        throw new DomainError("mesh_peer_signature_invalid", "The Mesh terminal session signature is invalid.");
      }
      await this.assertTrustedCaller(request);
      const pathStyle = executionPathStyleForPlatform(process.platform);
      if (!pathStyle) {
        throw new DomainError(
          "mesh_execution_path_invalid",
          "The worker operating system does not provide supported path semantics.",
        );
      }
      const trustedRoot = await resolveTrustedExecutionRoot(
        getMeshWorkerDirectory(),
        request.executionRoot,
        pathStyle,
      );
      const directory = await assertPhysicalExecutionPath(
        trustedRoot,
        request.directory,
      );
      request.executionRoot = trustedRoot.physicalExecutionRoot;
      request.directory = directory;
      const decryptedEnvironment = request.encryptedEnvironment === undefined
        ? undefined
        : await decryptMeshPayload(request.encryptedEnvironment);
      const environment = parseManagedContextEnvironment(
        decryptedEnvironment,
        "mesh_terminal_environment_invalid",
      );
      const expiresAt = Math.min(expiresAtRequest, Date.now() + MESH_TERMINAL_SESSION_TTL_MS);
      const sessionId = crypto.randomUUID();
      const lease: MeshTerminalLease = {
        sessionId,
        sessionToken: randomBytes(32).toString("base64url"),
        callerNodeId: request.callerNodeId,
        expiresAt,
        request,
        environment,
      };
      const expiryTimer = setTimeout(() => {
        this.closeInBackground(
          sessionId,
          true,
          1000,
          "Mesh terminal session expired",
        );
      }, Math.max(1, expiresAt - Date.now()));
      expiryTimer.unref?.();
      lease.expiryTimer = expiryTimer;
      this.leases.set(sessionId, lease);
      nonceReservation.expiresAt = expiresAt;
      nonceReservation.reserved = false;
      while (this.leases.size > MAX_TERMINAL_SESSIONS) {
        const oldest = this.leases.keys().next().value as string | undefined;
        if (!oldest) break;
        this.closeInBackground(
          oldest,
          true,
          1013,
          "Mesh terminal capacity exceeded",
        );
      }
      while (this.usedNonces.size > MAX_USED_NONCES) {
        const oldestReusable = [...this.usedNonces.entries()]
          .find(([, entry]) => !entry.reserved);
        if (!oldestReusable) break;
        this.usedNonces.delete(oldestReusable[0]);
      }
      return {
        protocolVersion: MESH_TERMINAL_PROTOCOL_VERSION,
        capability: MESH_TERMINAL_CAPABILITY,
        sessionId,
        sessionToken: lease.sessionToken,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    } catch (error) {
      if (this.usedNonces.get(request.nonce) === nonceReservation) {
        this.usedNonces.delete(request.nonce);
      }
      throw error;
    }
  }

  async authorize(sessionId: string, sessionToken: string): Promise<void> {
    await this.requireValidatedLease(sessionId, sessionToken);
  }

  async releaseSession(
    sessionId: string,
    sessionToken: string,
  ): Promise<void> {
    const lease = this.leases.get(sessionId);
    if (!lease) {
      await this.closePromises.get(sessionId)?.promise;
      return;
    }
    if (lease.sessionToken !== sessionToken) {
      throw new DomainError(
        "mesh_terminal_session_invalid",
        "The Mesh terminal session is invalid.",
      );
    }
    await this.close(sessionId, true, 1000, "Mesh terminal session released");
  }

  async open(
    socket: MeshTerminalSocket,
    sessionId: string,
    sessionToken: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.relays.has(sessionId) || this.opening.has(sessionId)) {
      throw new DomainError("mesh_terminal_session_in_use", "The Mesh terminal session is already connected.");
    }
    this.openingSockets.set(sessionId, socket);
    const pending = Promise.resolve().then(
      async () => await this.openInternal(socket, sessionId, sessionToken),
    );
    this.opening.set(sessionId, pending);
    const abortHandler = (): void => {
      this.closeInBackground(
        sessionId,
        false,
        1000,
        "Mesh terminal opening aborted",
        socket,
      );
    };
    if (signal?.aborted) {
      abortHandler();
    } else {
      signal?.addEventListener("abort", abortHandler, { once: true });
    }
    try {
      await pending;
    } finally {
      signal?.removeEventListener("abort", abortHandler);
      if (this.opening.get(sessionId) === pending) {
        this.opening.delete(sessionId);
      }
      if (this.openingSockets.get(sessionId) === socket) {
        this.openingSockets.delete(sessionId);
      }
    }
  }

  private async openInternal(
    socket: MeshTerminalSocket,
    sessionId: string,
    sessionToken: string,
  ): Promise<void> {
    const lease = await this.requireValidatedLease(sessionId, sessionToken);
    if (this.relays.has(sessionId)) {
      throw new DomainError("mesh_terminal_session_in_use", "The Mesh terminal session is already connected.");
    }
    const pathStyle = executionPathStyleForPlatform(process.platform);
    if (
      !pathStyle
      || !isAbsoluteExecutionPath(lease.request.directory, pathStyle)
    ) {
      throw new DomainError(
        "mesh_execution_path_invalid",
        "The validated Mesh terminal directory must be an absolute host path.",
      );
    }
    const executor = new CommandExecutorImpl({
      provider: "local",
      directory: lease.request.executionRoot,
    });
    const connection = new LocalTerminalConnection({
      sessionId: lease.request.terminalSessionId,
      remoteSessionName: lease.request.remoteSessionName,
      directory: lease.request.directory,
      connectionMode: lease.request.connectionMode,
      useTmux: lease.request.useTmux,
      allowPersistentSessionCreate: lease.request.allowPersistentSessionCreate,
      executor,
      environment: lease.environment,
      callbacks: {
        onOutput: (chunk) => {
          for (const boundedChunk of splitUtf8(chunk, MESH_TERMINAL_MAX_OUTPUT_BYTES)) {
            this.sendFrame(sessionId, { type: "terminal.output", data: boundedChunk }, socket);
          }
        },
        onClipboardCopy: (text) => {
          if (Buffer.byteLength(text, "utf8") > MESH_TERMINAL_MAX_CLIPBOARD_BYTES) {
            this.sendFrame(sessionId, {
              type: "terminal.error",
              code: "mesh_terminal_clipboard_too_large",
              message: "The terminal clipboard payload exceeds the size limit.",
            }, socket);
            return;
          }
          this.sendFrame(sessionId, { type: "terminal.clipboard", text }, socket);
        },
        onError: (error) => {
          const payload = isDomainError(error)
            ? { code: error.code, message: error.message }
            : { message: "The terminal process failed." };
          this.sendFrame(sessionId, { type: "terminal.error", ...payload }, socket);
        },
        onExit: (code, signal) => {
          this.sendFrame(sessionId, { type: "terminal.exit", code, signal }, socket);
          const relay = this.relays.get(sessionId);
          if (relay?.socket === socket) {
            this.closeInBackground(
              sessionId,
              true,
              1000,
              "Terminal process exited",
              socket,
            );
          }
        },
      },
    });
    const validationTimer = setInterval(() => {
      void this.requireValidatedLease(sessionId, sessionToken).catch(() => {
        this.closeInBackground(
          sessionId,
          true,
          1008,
          "Mesh terminal authority changed",
        );
      });
    }, MESH_TERMINAL_LEASE_CHECK_INTERVAL_MS);
    validationTimer.unref?.();
    this.relays.set(sessionId, { socket, connection, validationTimer });
    if (this.closing.has(sessionId)) {
      await this.cleanup(sessionId, socket);
      return;
    }
    try {
      const result = await connection.connect();
      if (this.closing.has(sessionId) || !this.relays.has(sessionId)) {
        await this.cleanup(sessionId);
        return;
      }
      this.sendFrame(sessionId, {
        type: "terminal.ready",
        runtimeConnectionMode: result.runtimeConnectionMode,
        ...(result.notice ? { notice: result.notice } : {}),
      });
    } catch (error) {
      if (isDomainError(error)) {
        this.sendFrame(sessionId, {
          type: "terminal.error",
          code: error.code,
          message: error.message,
        }, socket);
      }
      await this.cleanup(sessionId, socket);
      throw error;
    }
  }

  async message(
    sessionId: string,
    sessionToken: string,
    value: string | Buffer,
    socket?: MeshTerminalSocket,
  ): Promise<void> {
    this.assertSocketOwner(sessionId, socket);
    const opening = this.opening.get(sessionId);
    if (opening) {
      await opening;
    }
    this.assertSocketOwner(sessionId, socket);
    await this.requireValidatedLease(sessionId, sessionToken);
    this.assertSocketOwner(sessionId, socket);
    const relay = this.relays.get(sessionId);
    if (!relay) {
      throw new DomainError("mesh_terminal_connection_unavailable", "The Mesh terminal connection is unavailable.");
    }
    const text = typeof value === "string" ? value : value.toString("utf8");
    if (Buffer.byteLength(text, "utf8") > MESH_TERMINAL_MAX_FRAME_BYTES) {
      throw new DomainError("mesh_terminal_frame_too_large", "The Mesh terminal frame exceeds the size limit.");
    }
    let frame: MeshTerminalClientFrame;
    try {
      frame = MeshTerminalClientFrameSchema.parse(JSON.parse(text) as unknown);
    } catch (error) {
      throw new DomainError("mesh_terminal_frame_invalid", "The Mesh terminal frame is invalid.", {
        cause: error,
      });
    }
    switch (frame.type) {
      case "terminal.input":
        relay.connection.sendInput(frame.data);
        return;
      case "terminal.resize":
        await relay.connection.resize(frame.cols, frame.rows);
        return;
      case "terminal.close":
        await this.close(sessionId, true, 1000, "Terminal closed", socket);
        return;
      case "ping":
        this.sendFrame(sessionId, { type: "pong" });
    }
  }

  async close(
    sessionId: string,
    closeSocket = false,
    closeCode = 1000,
    closeReason = "Mesh terminal closed",
    ownerSocket?: MeshTerminalSocket,
  ): Promise<void> {
    if (!this.isSocketOwner(sessionId, ownerSocket)) {
      return;
    }
    const existing = this.closePromises.get(sessionId);
    if (existing) {
      if (closeSocket) {
        existing.closeSocket = true;
        existing.closeCode = closeCode;
        existing.closeReason = closeReason;
      }
      await existing.promise;
      return;
    }
    const state: MeshTerminalCloseState = {
      promise: Promise.resolve(),
      closeSocket,
      closeCode,
      closeReason,
    };
    state.promise = this.closeInternal(sessionId, state).finally(() => {
      if (this.closePromises.get(sessionId) === state) {
        this.closePromises.delete(sessionId);
      }
    });
    this.closePromises.set(sessionId, state);
    await state.promise;
  }

  closeInBackground(
    sessionId: string,
    closeSocket = false,
    closeCode = 1000,
    closeReason = "Mesh terminal closed",
    ownerSocket?: MeshTerminalSocket,
  ): void {
    void this.close(
      sessionId,
      closeSocket,
      closeCode,
      closeReason,
      ownerSocket,
    ).catch((error: Error) => {
      log.error("Failed to close the Mesh terminal session", {
        sessionId,
        closeReason,
        error: String(error),
      });
    });
  }

  private async closeInternal(
    sessionId: string,
    state: MeshTerminalCloseState,
  ): Promise<void> {
    const relay = this.relays.get(sessionId);
    const socket = relay?.socket ?? this.openingSockets.get(sessionId);
    const opening = this.opening.get(sessionId);
    const teardownErrors: unknown[] = [];
    if (opening && !this.closing.has(sessionId)) {
      this.closing.add(sessionId);
      if (relay) {
        try {
          await relay.connection.dispose();
        } catch (error) {
          teardownErrors.push(error);
        }
      }
      try {
        await opening;
      } catch {
        // The opening failure is surfaced to its original caller.
      } finally {
        this.closing.delete(sessionId);
      }
    }
    const socketToClose = this.relays.get(sessionId)?.socket ?? socket;
    try {
      await this.cleanup(sessionId);
    } catch (error) {
      teardownErrors.push(error);
    } finally {
      if (state.closeSocket && socketToClose) {
        try {
          socketToClose.close(state.closeCode, state.closeReason);
        } catch {
          // The transport may already be closed.
        }
      }
    }
    if (teardownErrors.length === 1) {
      throw teardownErrors[0];
    }
    if (teardownErrors.length > 1) {
      throw new AggregateError(
        teardownErrors,
        "Failed to fully terminate the Mesh terminal session.",
      );
    }
  }

  async closeAll(): Promise<void> {
    const sessionIds = new Set([
      ...this.leases.keys(),
      ...this.relays.keys(),
      ...this.opening.keys(),
      ...this.closePromises.keys(),
    ]);
    await Promise.all([...sessionIds].map(
      async (sessionId) => await this.close(sessionId, true, 1001, "Mesh terminal gateway stopped"),
    ));
    this.usedNonces.clear();
  }

  private async assertTrustedCaller(request: MeshTerminalSessionRequest): Promise<void> {
    const identity = await ensureLocalMeshNodeIdentity();
    if (request.targetNodeId !== identity.nodeId) {
      throw new DomainError("mesh_terminal_target_invalid", "The terminal request targets another Mesh node.");
    }
    await requireTrustedController({
      controllerNodeId: request.callerNodeId,
      publicKey: request.callerPublicKey,
      fingerprint: request.callerFingerprint,
      encryptionPublicKey: request.callerEncryptionPublicKey,
      requireEncryptionKey: true,
      context: "terminal caller",
    });
  }

  private async requireValidatedLease(
    sessionId: string,
    sessionToken: string,
  ): Promise<MeshTerminalLease> {
    await requireLocalMeshExecutionCapability("interactiveTerminal");
    this.pruneExpired();
    const lease = this.leases.get(sessionId);
    if (!lease || lease.sessionToken !== sessionToken) {
      throw new DomainError("mesh_terminal_session_invalid", "The Mesh terminal session is invalid.");
    }
    if (lease.expiresAt <= Date.now()) {
      await this.closeInvalidLease(
        sessionId,
        1000,
        "Mesh terminal session expired",
      );
      throw new DomainError("mesh_terminal_session_expired", "The Mesh terminal session has expired.");
    }
    const grant = await getControllerGrant(lease.callerNodeId);
    if (!grant || grant.grantStatus !== "active") {
      await this.closeInvalidLease(
        sessionId,
        1008,
        "Mesh terminal authority changed",
      );
      throw new DomainError("mesh_terminal_context_changed", "The Mesh terminal controller grant is no longer active.");
    }
    return lease;
  }

  private async closeInvalidLease(
    sessionId: string,
    closeCode: number,
    closeReason: string,
  ): Promise<void> {
    if (this.opening.has(sessionId)) {
      this.closeInBackground(sessionId, true, closeCode, closeReason);
      return;
    }
    await this.close(sessionId, true, closeCode, closeReason);
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [nonce, entry] of this.usedNonces) {
      if (!entry.reserved && entry.expiresAt <= now) {
        this.usedNonces.delete(nonce);
      }
    }
    for (const [sessionId, lease] of this.leases) {
      if (lease.expiresAt <= now) {
        this.closeInBackground(
          sessionId,
          true,
          1000,
          "Mesh terminal session expired",
        );
      }
    }
  }

  private deleteLease(sessionId: string): void {
    const lease = this.leases.get(sessionId);
    this.leases.delete(sessionId);
    if (lease?.expiryTimer) {
      clearTimeout(lease.expiryTimer);
      lease.expiryTimer = undefined;
    }
  }

  private async cleanup(sessionId: string, ownerSocket?: MeshTerminalSocket): Promise<void> {
    const relay = this.relays.get(sessionId);
    if (ownerSocket && relay && relay.socket !== ownerSocket) {
      return;
    }
    if (!relay) {
      this.deleteLease(sessionId);
      return;
    }
    clearInterval(relay.validationTimer);
    await relay.connection.dispose();
    if (this.relays.get(sessionId) !== relay) {
      return;
    }
    this.relays.delete(sessionId);
    this.deleteLease(sessionId);
  }

  private sendFrame(
    sessionId: string,
    frame: MeshTerminalServerFrame,
    ownerSocket?: MeshTerminalSocket,
  ): void {
    const relay = this.relays.get(sessionId);
    if (!relay || (ownerSocket && relay.socket !== ownerSocket)) {
      return;
    }
    const serialized = JSON.stringify(frame);
    if (Buffer.byteLength(serialized, "utf8") > MESH_TERMINAL_MAX_FRAME_BYTES) {
      this.closeInBackground(
        sessionId,
        true,
        1009,
        "Mesh terminal frame too large",
        ownerSocket,
      );
      return;
    }
    try {
      relay.socket.send(serialized);
    } catch {
      this.closeInBackground(
        sessionId,
        false,
        1000,
        "Mesh terminal closed",
        ownerSocket,
      );
    }
  }

  private isSocketOwner(
    sessionId: string,
    ownerSocket?: MeshTerminalSocket,
  ): boolean {
    if (!ownerSocket) {
      return true;
    }
    const relay = this.relays.get(sessionId);
    const openingSocket = this.openingSockets.get(sessionId);
    return !(
      (relay && relay.socket !== ownerSocket)
      || (!relay && openingSocket && openingSocket !== ownerSocket)
    );
  }

  private assertSocketOwner(sessionId: string, socket?: MeshTerminalSocket): void {
    if (!this.isSocketOwner(sessionId, socket)) {
      throw new DomainError("mesh_terminal_session_in_use", "The Mesh terminal session is already connected.");
    }
  }
}

export const meshTerminalGateway = new MeshTerminalGateway();

meshInboundResourceRegistry.register({
  id: "terminal",
  capabilities: ["interactiveTerminal"],
  close: async () => await meshTerminalGateway.closeAll(),
});
