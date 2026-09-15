/**
 * Node-side Mesh relay control connection.
 *
 * A connector owns exactly one authenticated outbound control WebSocket for a
 * local controller or worker. It verifies the relay challenge against the
 * expected relay fingerprint, authenticates with the local Mesh signing key,
 * and then multiplexes ticketed data streams: outbound streams correlated by
 * request id, and inbound offers dispatched to an injected handler.
 *
 * The connector is deliberately one-shot. Reconnect policy lives in
 * `MeshRelayConnectorManager` so a pairing attempt can never retry silently.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "@pablozaiden/webapp/server";
import {
  MeshRelayAuthOkFrameSchema,
  MeshRelayAuthorizationAckFrameSchema,
  MeshRelayChallengeFrameSchema,
  MeshRelayControlErrorFrameSchema,
  MeshRelayHeartbeatFrameSchema,
  MeshRelayPeerIdentitySchema,
  MeshRelayStreamOfferFrameSchema,
  MeshRelayStreamTicketFrameSchema,
} from "@/contracts/schemas/mesh-relay";
import {
  MESH_RELAY_CONTROL_PATH,
  MESH_RELAY_MAX_AUTHORIZATION_STAGED_BYTES,
  MESH_RELAY_MAX_AUTHORIZED_WORKERS,
  MESH_RELAY_PROTOCOL_VERSION,
  normalizeMeshRelayOrigin,
  type MeshRelayAuthFrame,
  type MeshRelayAuthOkFrame,
  type MeshRelayClientControlFrame,
  type MeshRelayPeerIdentity,
  type MeshRelayPeerRole,
  type MeshRelayStreamKind,
  type MeshRelayStreamOfferFrame,
  type MeshRelayWorkerStatus,
} from "@/shared/mesh-relay";
import {
  ensureLocalMeshNodeIdentity,
  signMeshPayload,
} from "../persistence/mesh-node-identity";
import {
  openMeshRelayClientSocket,
  toMeshRelayCloseCode,
  toMeshRelayCloseReason,
  type MeshRelayClientSocket,
  type MeshRelayClientSocketFactory,
} from "./mesh-relay-client-socket";
import {
  MeshRelayDataStream,
  openMeshRelayDataStream,
  MESH_RELAY_DATA_OPEN_TIMEOUT_MS,
} from "./mesh-relay-data-stream";
import { MeshRelayStreamError } from "./mesh-relay-errors";
import {
  getMeshRelayFingerprint,
  verifyMeshRelaySignature,
} from "./mesh-relay-identity";
import {
  MESH_RELAY_MAX_CONTROL_FRAME_BYTES,
  isMeshRelayRouteAllowed,
} from "./mesh-relay-policy";
import {
  buildMeshRelayAuthSigningPayload,
  buildMeshRelayChallengeSigningPayload,
} from "./mesh-relay-protocol";

const log = createLogger("core:mesh-relay-connector");

export const MESH_RELAY_CONNECT_TIMEOUT_MS = 15_000;
export const MESH_RELAY_HEARTBEAT_TIMEOUT_MS = 45_000;
export const MESH_RELAY_STREAM_REQUEST_TIMEOUT_MS = 15_000;
export const MESH_RELAY_AUTHORIZATION_TIMEOUT_MS = 15_000;
export const MESH_RELAY_MAX_PENDING_REQUESTS = 64;
export const MESH_RELAY_MAX_INBOUND_STREAMS = 64;
const HEARTBEAT_MONITOR_INTERVAL_MS = 5_000;
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

export type MeshRelayConnectorStatus =
  | "idle"
  | "connecting"
  | "authenticating"
  | "connected"
  | "closed";

export interface MeshRelayConnectorConfig {
  /** Absolute relay origin, for example `https://relay.example.com`. */
  relayUrl: string;
  /** Relay identity fingerprint pinned by pairing. */
  relayFingerprint: string;
  /** Role this node presents to the relay. */
  role: MeshRelayPeerRole;
  /** Default peer node id this connection talks to. */
  targetNodeId?: string;
  /** Controller-signed token used only for an unknown worker's enrollment. */
  enrollmentAdmission?: string;
}

export interface MeshRelayConnectorIdentity {
  nodeId: string;
  publicKey: string;
  fingerprint: string;
  sign(payload: string): Promise<string>;
}

export interface MeshRelayOfferContext {
  role: MeshRelayPeerRole;
  relayUrl: string;
  /** Dial the receiving side of the offered stream and consume `stream.ready`. */
  openDataStream(timeoutMs?: number): Promise<MeshRelayDataStream>;
  /** Report the served HTTP status so the relay can audit the stream. */
  reportStatus(status: number): void;
}

export interface MeshRelayInboundHandler {
  handleOffer(
    offer: MeshRelayStreamOfferFrame,
    context: MeshRelayOfferContext,
  ): Promise<void>;
}

export interface MeshRelayStreamRequestInput {
  kind: MeshRelayStreamKind;
  method?: string;
  path: string;
  headers: Record<string, string>;
  targetNodeId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface MeshRelayConnectorOptions {
  config: MeshRelayConnectorConfig;
  inbound?: MeshRelayInboundHandler;
  identity?: MeshRelayConnectorIdentity;
  socketFactory?: MeshRelayClientSocketFactory;
  connectTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  streamRequestTimeoutMs?: number;
  dataOpenTimeoutMs?: number;
  maxPendingRequests?: number;
  maxInboundStreams?: number;
  authorizationTimeoutMs?: number;
  onStatusChange?(status: MeshRelayConnectorStatus): void;
  onAuthenticated?(frame: MeshRelayAuthOkFrame): void;
  onClosed?(info: { code: number; reason: string }): void;
}

interface PendingTicket {
  resolve(frame: ReturnType<typeof MeshRelayStreamTicketFrameSchema.parse>): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingAuthorization {
  resolve(workerCount: number): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
  expectedWorkerCount: number;
}

function controlUrl(relayUrl: string): string {
  const base = new URL(relayUrl);
  base.protocol = base.protocol === "http:" ? "ws:" : "wss:";
  return new URL(MESH_RELAY_CONTROL_PATH, base).toString();
}

function controlFrameBytes(frame: MeshRelayClientControlFrame): number {
  return Buffer.byteLength(JSON.stringify(frame), "utf8");
}

function authorizationIdentityBytes(identity: MeshRelayPeerIdentity): number {
  return Buffer.byteLength(JSON.stringify(identity), "utf8");
}

export interface ValidatedMeshRelayAuthorization {
  workers: MeshRelayPeerIdentity[];
  identityBytes: number;
}

/**
 * Validate a complete authorization snapshot before any transaction frame is
 * sent. The returned identities contain the schema-normalized values.
 */
export function validateMeshRelayAuthorization(
  workers: readonly MeshRelayPeerIdentity[],
): ValidatedMeshRelayAuthorization {
  if (workers.length > MESH_RELAY_MAX_AUTHORIZED_WORKERS) {
    throw new MeshRelayStreamError(
      "mesh_relay_authorization_too_many_workers",
      "The Mesh relay authorization snapshot exceeds the worker limit.",
      { status: 413 },
    );
  }
  const nodeIds = new Set<string>();
  const fingerprints = new Set<string>();
  const validated: MeshRelayPeerIdentity[] = [];
  let identityBytes = 0;
  for (const input of workers) {
    const parsed = MeshRelayPeerIdentitySchema.safeParse(input);
    if (!parsed.success) {
      throw new MeshRelayStreamError(
        "mesh_relay_worker_identity_invalid",
        "A worker has an invalid Mesh identity.",
        { status: 400, cause: parsed.error },
      );
    }
    const worker = parsed.data;
    let derived: string;
    try {
      derived = getMeshRelayFingerprint(worker.publicKey);
    } catch (error) {
      throw new MeshRelayStreamError(
        "mesh_relay_worker_identity_invalid",
        `Worker "${worker.nodeId}" has an invalid Mesh public key.`,
        { status: 400, cause: error },
      );
    }
    if (
      derived !== worker.fingerprint
      || nodeIds.has(worker.nodeId)
      || fingerprints.has(worker.fingerprint)
    ) {
      throw new MeshRelayStreamError(
        "mesh_relay_worker_identity_invalid",
        `Worker "${worker.nodeId}" has an invalid or duplicate Mesh identity.`,
        { status: 400 },
      );
    }
    nodeIds.add(worker.nodeId);
    fingerprints.add(worker.fingerprint);
    identityBytes += authorizationIdentityBytes(worker);
    if (identityBytes > MESH_RELAY_MAX_AUTHORIZATION_STAGED_BYTES) {
      throw new MeshRelayStreamError(
        "mesh_relay_authorization_too_large",
        "The Mesh relay authorization snapshot exceeds the staged byte limit.",
        { status: 413 },
      );
    }
    validated.push(worker);
  }
  return { workers: validated, identityBytes };
}

/**
 * Partition identities by their actual serialized frame size. An identity is
 * never split, and every returned chunk is safe for the control-frame limit.
 */
export function chunkMeshRelayAuthorization(
  transactionId: string,
  workers: readonly MeshRelayPeerIdentity[],
): MeshRelayPeerIdentity[][] {
  const chunks: MeshRelayPeerIdentity[][] = [];
  let current: MeshRelayPeerIdentity[] = [];
  const emptyFrameBytes = controlFrameBytes({
    protocolVersion: MESH_RELAY_PROTOCOL_VERSION,
    type: "authorization.chunk",
    transactionId,
    workers: [],
  });
  let currentBytes = emptyFrameBytes;
  for (const worker of workers) {
    const workerBytes = authorizationIdentityBytes(worker);
    const separatorBytes = current.length > 0 ? 1 : 0;
    if (
      currentBytes + separatorBytes + workerBytes
      <= MESH_RELAY_MAX_CONTROL_FRAME_BYTES
    ) {
      current.push(worker);
      currentBytes += separatorBytes + workerBytes;
      continue;
    }
    if (current.length === 0) {
      throw new MeshRelayStreamError(
        "mesh_relay_authorization_identity_too_large",
        `Worker "${worker.nodeId}" cannot fit in a Mesh relay control frame.`,
        { status: 413 },
      );
    }
    chunks.push(current);
    current = [worker];
    currentBytes = emptyFrameBytes + workerBytes;
    if (currentBytes > MESH_RELAY_MAX_CONTROL_FRAME_BYTES) {
      throw new MeshRelayStreamError(
        "mesh_relay_authorization_identity_too_large",
        `Worker "${worker.nodeId}" cannot fit in a Mesh relay control frame.`,
        { status: 413 },
      );
    }
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

async function resolveDefaultIdentity(): Promise<MeshRelayConnectorIdentity> {
  const identity = await ensureLocalMeshNodeIdentity();
  return {
    nodeId: identity.nodeId,
    publicKey: identity.publicKey,
    fingerprint: identity.fingerprint,
    sign: signMeshPayload,
  };
}

export class MeshRelayConnector {
  private socket?: MeshRelayClientSocket;
  private relayUrl?: string;
  private state: MeshRelayConnectorStatus = "idle";
  private authFrame?: MeshRelayAuthOkFrame;
  private readonly pendingTickets = new Map<string, PendingTicket>();
  private readonly pendingAuthorizations = new Map<string, PendingAuthorization>();
  private authorizationTail: Promise<void> = Promise.resolve();
  private readonly activeOffers = new Set<string>();
  private lastServerFrameAt = 0;
  private heartbeatMonitor?: ReturnType<typeof setInterval>;
  private connectSettled = false;
  private resolveConnect?: (frame: MeshRelayAuthOkFrame) => void;
  private rejectConnect?: (error: unknown) => void;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private detachSocket: () => void = () => {};

  constructor(private readonly options: MeshRelayConnectorOptions) {}

  get status(): MeshRelayConnectorStatus {
    return this.state;
  }

  get config(): MeshRelayConnectorConfig {
    return this.options.config;
  }

  get authorization(): MeshRelayAuthOkFrame | undefined {
    return this.authFrame;
  }

  get workerStatus(): MeshRelayWorkerStatus | undefined {
    return this.authFrame?.workerStatus;
  }

  /** Open and authenticate the control connection exactly once. */
  async connect(): Promise<MeshRelayAuthOkFrame> {
    if (this.state !== "idle") {
      throw new MeshRelayStreamError(
        "mesh_relay_connector_reused",
        "A Mesh relay connector cannot be reconnected; create a new one.",
      );
    }
    this.setStatus("connecting");
    let relayUrl: string;
    try {
      relayUrl = normalizeMeshRelayOrigin(this.options.config.relayUrl);
    } catch (error) {
      this.setStatus("closed");
      throw new MeshRelayStreamError(
        "mesh_relay_url_invalid",
        "Remote Mesh relay connections require HTTPS.",
        { status: 400, cause: error },
      );
    }
    this.relayUrl = relayUrl;
    const identity = this.options.identity ?? await resolveDefaultIdentity();
    const factory = this.options.socketFactory ?? openMeshRelayClientSocket;
    const socket = factory(controlUrl(relayUrl));
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.lastServerFrameAt = Date.now();

    const onMessage = (event: MessageEvent): void => {
      void this.handleControlMessage(event, identity);
    };
    const onClose = (event: CloseEvent): void => {
      this.finalize(event.code, event.reason || "The Mesh relay connection closed.");
    };
    const onError = (): void => {
      this.finalize(1006, "The Mesh relay connection failed.");
    };
    this.detachSocket = (): void => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);

    const connected = new Promise<MeshRelayAuthOkFrame>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    this.connectTimer = setTimeout(() => {
      this.failConnect(new MeshRelayStreamError(
        "mesh_relay_connect_timeout",
        "The Mesh relay connection did not authenticate in time.",
        { status: 504 },
      ));
      this.close(4410, "Mesh relay authentication timed out");
    }, this.options.connectTimeoutMs ?? MESH_RELAY_CONNECT_TIMEOUT_MS);
    this.connectTimer.unref?.();
    return await connected;
  }

  /** Close the control connection and release every owned resource. */
  close(code = 1000, reason = "Mesh relay connection closed"): void {
    const socket = this.socket;
    if (socket && socket.readyState <= 1) {
      try {
        socket.close(toMeshRelayCloseCode(code), toMeshRelayCloseReason(reason));
      } catch (error) {
        log.debug("Mesh relay control close was rejected", { error: String(error) });
      }
    }
    this.finalize(code, reason);
  }

  /**
   * Replace the relay's authorized worker snapshot and wait for the ack.
   * Transactions are serialized so their begin/chunk/commit frames cannot
   * cancel or interleave with another replacement on the same connection.
   */
  async replaceAuthorization(workers: MeshRelayPeerIdentity[]): Promise<number> {
    const previous = this.authorizationTail;
    let release: () => void = () => {};
    this.authorizationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.sendAuthorizationTransaction(workers);
    } finally {
      release();
    }
  }

  private async sendAuthorizationTransaction(
    workers: MeshRelayPeerIdentity[],
  ): Promise<number> {
    this.assertConnected();
    if (this.options.config.role !== "controller") {
      throw new MeshRelayStreamError(
        "mesh_relay_authorization_forbidden",
        "Only a controller relay connection may replace worker authorization.",
        { status: 403 },
      );
    }
    const validated = validateMeshRelayAuthorization(workers);
    const transactionId = randomUUID();
    const chunks = chunkMeshRelayAuthorization(
      transactionId,
      validated.workers,
    );
    const acked = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAuthorizations.delete(transactionId);
        reject(new MeshRelayStreamError(
          "mesh_relay_authorization_timeout",
          "The Mesh relay did not acknowledge the worker authorization.",
          { status: 504 },
        ));
      }, this.options.authorizationTimeoutMs
        ?? MESH_RELAY_AUTHORIZATION_TIMEOUT_MS);
      timer.unref?.();
      this.pendingAuthorizations.set(transactionId, {
        resolve,
        reject,
        timer,
        expectedWorkerCount: validated.workers.length,
      });
    });
    try {
      this.sendControl({
        protocolVersion: MESH_RELAY_PROTOCOL_VERSION,
        type: "authorization.begin",
        transactionId,
        workerCount: validated.workers.length,
        identityBytes: validated.identityBytes,
      });
      for (const chunk of chunks) {
        this.sendControl({
          protocolVersion: MESH_RELAY_PROTOCOL_VERSION,
          type: "authorization.chunk",
          transactionId,
          workers: chunk,
        });
      }
      this.sendControl({
        protocolVersion: MESH_RELAY_PROTOCOL_VERSION,
        type: "authorization.commit",
        transactionId,
      });
    } catch (error) {
      const pending = this.pendingAuthorizations.get(transactionId);
      if (pending) {
        this.pendingAuthorizations.delete(transactionId);
        clearTimeout(pending.timer);
        pending.reject(error);
      }
    }
    return await acked;
  }

  /**
   * Request a stream from the relay, dial the initiator data socket, and
   * return it once `stream.ready` has been consumed.
   */
  async openStream(input: MeshRelayStreamRequestInput): Promise<MeshRelayDataStream> {
    this.assertConnected();
    if (input.signal?.aborted) {
      throw new MeshRelayStreamError(
        "mesh_relay_request_aborted",
        "The Mesh relay request was aborted.",
        { status: 499 },
      );
    }
    const targetNodeId = input.targetNodeId ?? this.options.config.targetNodeId;
    if (!targetNodeId) {
      throw new MeshRelayStreamError(
        "mesh_relay_target_missing",
        "The Mesh relay stream has no target node.",
        { status: 400 },
      );
    }
    const pathname = new URL(
      input.path.startsWith("/") ? input.path : `/${input.path}`,
      "https://mesh.invalid",
    ).pathname;
    if (!isMeshRelayRouteAllowed(
      this.options.config.role,
      input.kind,
      input.method,
      pathname,
    )) {
      throw new MeshRelayStreamError(
        "mesh_relay_route_forbidden",
        `The Mesh route "${pathname}" may not be opened through the relay.`,
        { status: 403 },
      );
    }
    if (this.pendingTickets.size >= (this.options.maxPendingRequests ?? MESH_RELAY_MAX_PENDING_REQUESTS)) {
      throw new MeshRelayStreamError(
        "mesh_relay_pending_limit",
        "The Mesh relay connection has too many pending stream requests.",
        { status: 429 },
      );
    }
    const requestId = randomUUID();
    const timeoutMs = input.timeoutMs
      ?? this.options.streamRequestTimeoutMs
      ?? MESH_RELAY_STREAM_REQUEST_TIMEOUT_MS;
    let abortTicket: (() => void) | undefined;
    let requestSent = false;
    const ticketed = new Promise<ReturnType<typeof MeshRelayStreamTicketFrameSchema.parse>>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingTickets.delete(requestId);
          if (abortTicket) {
            input.signal?.removeEventListener("abort", abortTicket);
          }
          if (requestSent && this.status === "connected") {
            this.cancelStreamRequest(requestId);
          }
          reject(new MeshRelayStreamError(
            "mesh_relay_ticket_timeout",
            "The Mesh relay did not issue a stream ticket in time.",
            { status: 504 },
          ));
        }, timeoutMs);
        timer.unref?.();
        this.pendingTickets.set(requestId, { resolve, reject, timer });
        abortTicket = (): void => {
          const pending = this.pendingTickets.get(requestId);
          if (!pending) {
            return;
          }
          this.pendingTickets.delete(requestId);
          clearTimeout(pending.timer);
          if (requestSent && this.status === "connected") {
            this.cancelStreamRequest(requestId);
          }
          reject(new MeshRelayStreamError(
            "mesh_relay_request_aborted",
            "The Mesh relay request was aborted.",
            { status: 499 },
          ));
        };
        input.signal?.addEventListener("abort", abortTicket, { once: true });
      },
    );
    try {
      if (this.pendingTickets.has(requestId)) {
        this.sendControl({
          protocolVersion: MESH_RELAY_PROTOCOL_VERSION,
          type: "stream.request",
          requestId,
          targetNodeId,
          kind: input.kind,
          ...(input.method ? { method: input.method.toUpperCase() } : {}),
          path: input.path.startsWith("/") ? input.path : `/${input.path}`,
          headers: input.headers,
        });
        requestSent = true;
      }
    } catch (error) {
      const pending = this.pendingTickets.get(requestId);
      if (pending) {
        this.pendingTickets.delete(requestId);
        clearTimeout(pending.timer);
        pending.reject(error);
      }
    }
    let ticket: ReturnType<typeof MeshRelayStreamTicketFrameSchema.parse>;
    try {
      ticket = await ticketed;
    } finally {
      if (abortTicket) {
        input.signal?.removeEventListener("abort", abortTicket);
      }
    }
    try {
      const relayUrl = this.relayUrl;
      if (!relayUrl) {
        throw new MeshRelayStreamError(
          "mesh_relay_disconnected",
          "The Mesh relay connection has no validated relay origin.",
          { status: 503 },
        );
      }
      return await openMeshRelayDataStream({
        relayUrl,
        ticket: ticket.ticket,
        credential: ticket.credential,
        requestId,
        streamId: ticket.streamId,
        timeoutMs: this.options.dataOpenTimeoutMs ?? MESH_RELAY_DATA_OPEN_TIMEOUT_MS,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(this.options.socketFactory
          ? { socketFactory: this.options.socketFactory }
          : {}),
      });
    } catch (error) {
      this.cancelStreamRequest(requestId);
      throw error;
    }
  }

  /** Report a served HTTP status for relay stream auditing. */
  reportStreamStatus(streamId: string, status: number): void {
    if (this.state !== "connected" || status < 100 || status > 599) {
      return;
    }
    try {
      this.sendControl({
        protocolVersion: MESH_RELAY_PROTOCOL_VERSION,
        type: "stream.status",
        streamId,
        status,
      });
    } catch (error) {
      log.debug("Mesh relay stream status could not be reported", {
        streamId,
        error: String(error),
      });
    }
  }

  private assertConnected(): void {
    if (this.state !== "connected") {
      throw new MeshRelayStreamError(
        "mesh_relay_disconnected",
        "The Mesh relay control connection is not authenticated.",
        { status: 503 },
      );
    }
  }

  private setStatus(status: MeshRelayConnectorStatus): void {
    if (this.state === status) {
      return;
    }
    this.state = status;
    this.options.onStatusChange?.(status);
  }

  private sendControl(frame: MeshRelayClientControlFrame): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      throw new MeshRelayStreamError(
        "mesh_relay_disconnected",
        "The Mesh relay control connection is not writable.",
        { status: 503 },
      );
    }

    const serialized = JSON.stringify(frame);
    if (Buffer.byteLength(serialized, "utf8") > MESH_RELAY_MAX_CONTROL_FRAME_BYTES) {
      throw new MeshRelayStreamError(
        "mesh_relay_control_frame_too_large",
        "The Mesh relay control frame exceeds the transport limit.",
        { status: 413 },
      );
    }
    socket.send(serialized);
  }

  private cancelStreamRequest(requestId: string): void {
    if (this.status !== "connected") {
      return;
    }
    try {
      this.sendControl({
        protocolVersion: MESH_RELAY_PROTOCOL_VERSION,
        type: "stream.cancel",
        requestId,
      });
    } catch (error) {
      log.debug("A Mesh relay stream cancellation could not be sent", {
        requestId,
        error: String(error),
      });
    }
  }

  private async handleControlMessage(
    event: MessageEvent,
    identity: MeshRelayConnectorIdentity,
  ): Promise<void> {
    if (this.state === "closed") {
      return;
    }
    if (typeof event.data !== "string") {
      this.close(4400, "Mesh relay control frames must be JSON text");
      return;
    }
    if (Buffer.byteLength(event.data, "utf8") > MESH_RELAY_MAX_CONTROL_FRAME_BYTES) {
      this.close(1009, "Mesh relay control frame exceeds the size limit");
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(event.data);
    } catch (error) {
      log.warn("Malformed Mesh relay control frame", { error: String(error) });
      this.close(4400, "Malformed Mesh relay control frame");
      return;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      this.close(4400, "Invalid Mesh relay control frame");
      return;
    }
    const record = raw as Record<string, unknown>;
    if (record["protocolVersion"] !== MESH_RELAY_PROTOCOL_VERSION) {
      this.close(4400, "Unsupported Mesh relay protocol version");
      return;
    }
    this.lastServerFrameAt = Date.now();
    switch (record["type"]) {
      case "challenge":
        await this.handleChallenge(raw, identity);
        return;
      case "auth.ok":
        this.handleAuthOk(raw);
        return;
      case "authorization.ack":
        this.handleAuthorizationAck(raw);
        return;
      case "stream.ticket":
        this.handleStreamTicket(raw);
        return;
      case "stream.offer":
        this.handleStreamOffer(raw);
        return;
      case "stream.error":
        this.handleStreamError(raw);
        return;
      case "heartbeat":
        this.handleHeartbeat(raw);
        return;
      default:
        log.warn("Unknown Mesh relay control frame", { type: record["type"] });
        this.close(4400, "Unknown Mesh relay control frame");
    }
  }

  private async handleChallenge(
    raw: unknown,
    identity: MeshRelayConnectorIdentity,
  ): Promise<void> {
    if (this.state !== "connecting") {
      this.close(4400, "Unexpected Mesh relay challenge");
      return;
    }
    this.setStatus("authenticating");
    const parsed = MeshRelayChallengeFrameSchema.safeParse(raw);
    if (!parsed.success) {
      this.rejectChallenge("The Mesh relay challenge frame is invalid.");
      return;
    }
    const challenge = parsed.data;
    const now = Date.now();
    const expiresAt = Date.parse(challenge.expiresAt);
    const issuedAt = Date.parse(challenge.issuedAt);
    if (
      Number.isNaN(expiresAt)
      || Number.isNaN(issuedAt)
      || expiresAt <= now
      || issuedAt > now + CLOCK_SKEW_TOLERANCE_MS
    ) {
      this.rejectChallenge("The Mesh relay challenge is expired or not yet valid.");
      return;
    }
    if (challenge.relayFingerprint !== this.options.config.relayFingerprint) {
      this.rejectChallenge("The Mesh relay presented an unexpected fingerprint.");
      return;
    }
    let derived: string;
    try {
      derived = getMeshRelayFingerprint(challenge.relayPublicKey);
    } catch (error) {
      this.rejectChallenge("The Mesh relay public key is invalid.", error);
      return;
    }
    if (
      derived !== challenge.relayFingerprint
      || !verifyMeshRelaySignature(
        buildMeshRelayChallengeSigningPayload(challenge),
        challenge.signature,
        challenge.relayPublicKey,
      )
    ) {
      this.rejectChallenge("The Mesh relay challenge signature is not trusted.");
      return;
    }

    const unsigned: Omit<MeshRelayAuthFrame, "signature"> = {
      protocolVersion: MESH_RELAY_PROTOCOL_VERSION,
      type: "auth",
      role: this.options.config.role,
      nodeId: identity.nodeId,
      publicKey: identity.publicKey,
      fingerprint: identity.fingerprint,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      relayFingerprint: challenge.relayFingerprint,
      expiresAt: challenge.expiresAt,
      ...(this.options.config.enrollmentAdmission
        ? { enrollmentAdmission: this.options.config.enrollmentAdmission }
        : {}),
    };
    let signature: string;
    try {
      signature = await identity.sign(buildMeshRelayAuthSigningPayload(unsigned));
    } catch (error) {
      this.failConnect(new MeshRelayStreamError(
        "mesh_relay_auth_signing_failed",
        "The Mesh relay authentication frame could not be signed.",
        { cause: error },
      ));
      this.close(4401, "Mesh relay authentication failed");
      return;
    }
    if (this.status !== "authenticating") {
      return;
    }
    try {
      this.sendControl({ ...unsigned, signature });
    } catch (error) {
      this.failConnect(error);
      this.close(1011, "Mesh relay authentication could not be sent");
    }
  }

  private rejectChallenge(message: string, cause?: unknown): void {
    this.failConnect(new MeshRelayStreamError(
      "mesh_relay_challenge_invalid",
      message,
      cause === undefined ? { status: 502 } : { status: 502, cause },
    ));
    this.close(4401, "Mesh relay challenge rejected");
  }

  private handleAuthOk(raw: unknown): void {
    const parsed = MeshRelayAuthOkFrameSchema.safeParse(raw);
    if (!parsed.success || parsed.data.role !== this.options.config.role) {
      this.failConnect(new MeshRelayStreamError(
        "mesh_relay_auth_invalid",
        "The Mesh relay authentication acknowledgement is invalid.",
      ));
      this.close(4400, "Invalid Mesh relay authentication acknowledgement");
      return;
    }
    this.authFrame = parsed.data;
    const first = !this.connectSettled;
    this.setStatus("connected");
    if (first) {
      this.connectSettled = true;
      if (this.connectTimer) {
        clearTimeout(this.connectTimer);
        this.connectTimer = undefined;
      }
      this.startHeartbeatMonitor();
      this.resolveConnect?.(parsed.data);
      this.resolveConnect = undefined;
      this.rejectConnect = undefined;
    }
    this.options.onAuthenticated?.(parsed.data);
  }

  private handleAuthorizationAck(raw: unknown): void {
    const parsed = MeshRelayAuthorizationAckFrameSchema.safeParse(raw);
    if (!parsed.success) {
      this.close(4400, "Invalid Mesh relay authorization acknowledgement");
      return;
    }
    const pending = this.pendingAuthorizations.get(parsed.data.transactionId);
    if (!pending) {
      return;
    }
    this.pendingAuthorizations.delete(parsed.data.transactionId);
    clearTimeout(pending.timer);
    if (parsed.data.workerCount !== pending.expectedWorkerCount) {
      pending.reject(new MeshRelayStreamError(
        "mesh_relay_authorization_ack_invalid",
        "The Mesh relay acknowledged an unexpected worker count.",
        { status: 502 },
      ));
      this.close(4400, "Invalid Mesh relay authorization acknowledgement");
      return;
    }
    pending.resolve(parsed.data.workerCount);
  }

  private handleStreamTicket(raw: unknown): void {
    const parsed = MeshRelayStreamTicketFrameSchema.safeParse(raw);
    if (!parsed.success) {
      this.close(4400, "Invalid Mesh relay stream ticket");
      return;
    }
    const pending = this.pendingTickets.get(parsed.data.requestId);
    if (!pending) {
      log.debug("Discarding a Mesh relay ticket with no pending request", {
        requestId: parsed.data.requestId,
      });
      this.cancelStreamRequest(parsed.data.requestId);
      return;
    }
    this.pendingTickets.delete(parsed.data.requestId);
    clearTimeout(pending.timer);
    pending.resolve(parsed.data);
  }

  private handleStreamError(raw: unknown): void {
    const parsed = MeshRelayControlErrorFrameSchema.safeParse(raw);
    if (!parsed.success) {
      this.close(4400, "Invalid Mesh relay stream error");
      return;
    }
    const { requestId, code, message, status } = parsed.data;
    const error = new MeshRelayStreamError(
      `mesh_relay_${code}`,
      message,
      { status },
    );
    const ticket = this.pendingTickets.get(requestId);
    if (ticket) {
      this.pendingTickets.delete(requestId);
      clearTimeout(ticket.timer);
      ticket.reject(error);
      return;
    }
    const authorization = this.pendingAuthorizations.get(requestId);
    if (authorization) {
      this.pendingAuthorizations.delete(requestId);
      clearTimeout(authorization.timer);
      authorization.reject(error);
      return;
    }
    log.warn("Mesh relay reported an error for an unknown request", {
      requestId,
      code,
      status,
    });
  }

  private handleHeartbeat(raw: unknown): void {
    const parsed = MeshRelayHeartbeatFrameSchema.safeParse(raw);
    if (!parsed.success) {
      this.close(4400, "Invalid Mesh relay heartbeat");
      return;
    }
    try {
      this.sendControl({
        protocolVersion: MESH_RELAY_PROTOCOL_VERSION,
        type: "pong",
        sentAt: new Date().toISOString(),
      });
    } catch (error) {
      log.warn("The Mesh relay heartbeat could not be answered", {
        error: String(error),
      });
    }
  }

  private handleStreamOffer(raw: unknown): void {
    const parsed = MeshRelayStreamOfferFrameSchema.safeParse(raw);
    if (!parsed.success) {
      this.close(4400, "Invalid Mesh relay stream offer");
      return;
    }
    const offer = parsed.data as MeshRelayStreamOfferFrame;
    const inbound = this.options.inbound;
    if (!inbound) {
      log.warn("Discarding a Mesh relay offer with no inbound handler", {
        streamId: offer.streamId,
      });
      return;
    }
    if (this.activeOffers.size >= (this.options.maxInboundStreams ?? MESH_RELAY_MAX_INBOUND_STREAMS)) {
      log.warn("Discarding a Mesh relay offer past the inbound stream limit", {
        streamId: offer.streamId,
      });
      return;
    }
    this.activeOffers.add(offer.streamId);
    const relayUrl = this.relayUrl;
    if (!relayUrl) {
      this.activeOffers.delete(offer.streamId);
      this.close(4400, "Mesh relay connection has no validated origin");
      return;
    }
    const context: MeshRelayOfferContext = {
      role: this.options.config.role,
      relayUrl,
      openDataStream: async (timeoutMs?: number) => await openMeshRelayDataStream({
        relayUrl,
        ticket: offer.ticket,
        credential: offer.credential,
        requestId: offer.requestId,
        streamId: offer.streamId,
        timeoutMs: timeoutMs
          ?? this.options.dataOpenTimeoutMs
          ?? MESH_RELAY_DATA_OPEN_TIMEOUT_MS,
        ...(this.options.socketFactory
          ? { socketFactory: this.options.socketFactory }
          : {}),
      }),
      reportStatus: (status: number) => this.reportStreamStatus(offer.streamId, status),
    };
    void inbound.handleOffer(offer, context)
      .catch((error: unknown) => {
        log.warn("Mesh relay inbound stream failed", {
          streamId: offer.streamId,
          path: new URL(offer.path, "https://mesh.invalid").pathname,
          error: String(error),
        });
      })
      .finally(() => {
        this.activeOffers.delete(offer.streamId);
      });
  }

  private startHeartbeatMonitor(): void {
    const timeoutMs = this.options.heartbeatTimeoutMs ?? MESH_RELAY_HEARTBEAT_TIMEOUT_MS;
    this.heartbeatMonitor = setInterval(() => {
      if (Date.now() - this.lastServerFrameAt <= timeoutMs) {
        return;
      }
      log.warn("The Mesh relay control connection went silent", {
        relayUrl: this.options.config.relayUrl,
      });
      this.close(4410, "Mesh relay heartbeat timed out");
    }, HEARTBEAT_MONITOR_INTERVAL_MS);
    this.heartbeatMonitor.unref?.();
  }

  private failConnect(error: unknown): void {
    if (this.connectSettled) {
      return;
    }
    this.connectSettled = true;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
    const reject = this.rejectConnect;
    this.resolveConnect = undefined;
    this.rejectConnect = undefined;
    reject?.(error);
  }

  /** Deterministic teardown reachable from every close, error and timeout path. */
  private finalize(code: number, reason: string): void {
    if (this.state === "closed") {
      return;
    }
    this.setStatus("closed");
    this.detachSocket();
    this.detachSocket = () => {};
    if (this.heartbeatMonitor) {
      clearInterval(this.heartbeatMonitor);
      this.heartbeatMonitor = undefined;
    }
    const disconnected = new MeshRelayStreamError(
      "mesh_relay_disconnected",
      reason || "The Mesh relay control connection closed.",
      { status: 503 },
    );
    for (const [requestId, pending] of [...this.pendingTickets]) {
      this.pendingTickets.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(disconnected);
    }
    for (const [requestId, pending] of [...this.pendingAuthorizations]) {
      this.pendingAuthorizations.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(disconnected);
    }
    this.activeOffers.clear();
    this.failConnect(disconnected);
    this.options.onClosed?.({ code, reason });
  }
}
