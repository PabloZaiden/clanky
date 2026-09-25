/**
 * In-memory relay broker. HTTP/WebSocket adapters provide small socket
 * interfaces while this class owns authentication, authorization, tickets,
 * stream routing, limits, and deterministic cleanup.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { createLogger } from "@pablozaiden/webapp/server";
import {
  MeshRelayAuthFrameSchema,
  MeshRelayAuthorizationBeginFrameSchema,
  MeshRelayAuthorizationChunkFrameSchema,
  MeshRelayAuthorizationCommitFrameSchema,
  MeshRelayPongFrameSchema,
  MeshRelayStreamCancelFrameSchema,
  MeshRelayStreamRequestFrameSchema,
  MeshRelayStreamStatusFrameSchema,
} from "@/contracts/schemas/mesh-relay";
import {
  MESH_RELAY_CONTROL_CLOSE_REPLACED,
  MESH_RELAY_MAX_AUTHORIZATION_STAGED_BYTES,
  MESH_RELAY_MAX_AUTHORIZED_WORKERS,
  type MeshRelayAuthFrame,
  type MeshRelayAuthOkFrame,
  type MeshRelayAuthorizationBeginFrame,
  type MeshRelayAuthorizationChunkFrame,
  type MeshRelayAuthorizationCommitFrame,
  type MeshRelayChallengeFrame,
  type MeshRelayControlErrorFrame,
  type MeshRelayPeerIdentity,
  type MeshRelayPeerRole,
  type MeshRelayServerControlFrame,
  type MeshRelayStreamKind,
  type MeshRelayStreamOfferFrame,
  type MeshRelayStreamReadyFrame,
  type MeshRelayStreamRequestFrame,
  type MeshRelayStreamTicketFrame,
  type MeshRelayWorkerStatus,
} from "@/shared/mesh-relay";
import { MESH_PROTOCOL_VERSION } from "@/shared/mesh-protocol";
import {
  getMeshRelayFingerprint,
  verifyMeshRelaySignature,
  type MeshRelaySigningIdentity,
} from "./mesh-relay-identity";
import {
  buildMeshRelayAuthSigningPayload,
  buildMeshRelayChallengeSigningPayload,
} from "./mesh-relay-protocol";
import { verifyMeshRelayEnrollmentAdmission } from "./mesh-relay-admission";
import {
  MESH_RELAY_CONTROLLER_HTTP_ROUTES,
  MESH_RELAY_CONTROLLER_SOCKET_ROUTES,
  MESH_RELAY_MAX_CONTROL_FRAME_BYTES,
  MESH_RELAY_MAX_HEADER_BYTES,
  MESH_RELAY_MAX_QUEUED_BYTES,
  MESH_RELAY_MAX_STREAM_FRAME_BYTES,
  MESH_RELAY_PROHIBITED_HEADERS,
  MESH_RELAY_QUERY_ROUTE,
  MESH_RELAY_STREAM_CLOSE_CANCELLED,
  MESH_RELAY_STREAM_CLOSE_DISPATCH_FAILED,
  MESH_RELAY_STREAM_CLOSE_PROTOCOL_ERROR,
  MESH_RELAY_STREAM_CLOSE_REQUEST_FAILED,
  MESH_RELAY_STREAM_CLOSE_TIMEOUT,
} from "./mesh-relay-policy";
import { MeshRelayStore } from "./mesh-relay-store";

const log = createLogger("core:mesh-relay-broker");

interface RelayAuditEvent {
  eventType: string;
  role?: MeshRelayPeerRole;
  nodeId?: string;
  connectionId?: string;
  outcome?: string;
  errorCode?: string;
  occurredAt?: string;
}

interface RelayStreamAudit {
  streamId: string;
  initiatorNodeId: string;
  targetNodeId: string;
  kind: MeshRelayStreamKind;
  method?: string;
  path: string;
  status?: number;
  bytesToInitiator: number;
  bytesToReceiver: number;
  durationMs: number;
  outcome: string;
  errorCode?: string;
  occurredAt?: string;
}

function logRelayAudit(event: RelayAuditEvent): void {
  const details = {
    eventType: event.eventType,
    occurredAt: event.occurredAt ?? new Date().toISOString(),
    ...(event.role ? { role: event.role } : {}),
    ...(event.nodeId ? { nodeId: event.nodeId } : {}),
    ...(event.connectionId ? { connectionId: event.connectionId } : {}),
    ...(event.outcome ? { outcome: event.outcome } : {}),
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
  };
  if (
    event.outcome === "rejected"
    || event.outcome === "timeout"
    || event.outcome === "capacity"
    || event.outcome === "disconnected"
  ) {
    log.warn("Mesh relay event", details);
    return;
  }
  log.info("Mesh relay event", details);
}

function logRelayStreamAudit(stream: RelayStreamAudit): void {
  const details = {
    eventType: "stream.close",
    occurredAt: stream.occurredAt ?? new Date().toISOString(),
    streamId: stream.streamId,
    initiatorNodeId: stream.initiatorNodeId,
    targetNodeId: stream.targetNodeId,
    kind: stream.kind,
    ...(stream.method ? { method: stream.method } : {}),
    path: stream.path,
    ...(stream.status !== undefined ? { status: stream.status } : {}),
    bytesToInitiator: stream.bytesToInitiator,
    bytesToReceiver: stream.bytesToReceiver,
    durationMs: stream.durationMs,
    outcome: stream.outcome,
    ...(stream.errorCode ? { errorCode: stream.errorCode } : {}),
  };
  if (stream.outcome === "completed" || stream.outcome === "cancelled") {
    log.info("Mesh relay stream", details);
    return;
  }
  log.warn("Mesh relay stream", details);
}

export const RELAY_AUTH_TIMEOUT_MS = 10_000;
export const RELAY_CHALLENGE_LIFETIME_MS = 30_000;
export const RELAY_TICKET_LIFETIME_MS = 15_000;
export const RELAY_HEARTBEAT_INTERVAL_MS = 15_000;
export const RELAY_HEARTBEAT_TIMEOUT_MS = 45_000;
export const RELAY_AUTHORIZATION_TRANSACTION_TIMEOUT_MS = 15_000;
export const RELAY_MAX_CONNECTIONS = 1_024;
export const RELAY_MAX_PENDING_WORKERS = 128;
export const RELAY_MAX_STREAMS_PER_NODE = 32;
export const RELAY_MAX_TICKETS_PER_NODE = 64;
export const RELAY_MAX_CONTROL_FRAME_BYTES = MESH_RELAY_MAX_CONTROL_FRAME_BYTES;
export const RELAY_MAX_DATA_FRAME_BYTES = MESH_RELAY_MAX_STREAM_FRAME_BYTES;
export const RELAY_MAX_QUEUED_BYTES = MESH_RELAY_MAX_QUEUED_BYTES;

const CONTROL_CLOSE_INVALID = 4400;
const CONTROL_CLOSE_UNAUTHORIZED = 4401;
const CONTROL_CLOSE_TIMEOUT = 4410;
const CONTROL_CLOSE_CAPACITY = 4429;

const PROHIBITED_RELAY_HEADERS = MESH_RELAY_PROHIBITED_HEADERS;

const CONTROLLER_HTTP_ROUTES = MESH_RELAY_CONTROLLER_HTTP_ROUTES;

const CONTROLLER_SOCKET_ROUTES = MESH_RELAY_CONTROLLER_SOCKET_ROUTES;

export interface MeshRelaySocket {
  send(data: string | Uint8Array): number;
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
}

interface RelayChallengeState {
  challengeId: string;
  nonce: string;
  expiresAt: string;
}

interface RelayAuthorizationTransaction {
  transactionId: string;
  workerCount: number;
  identityBytes: number;
  stagedBytes: number;
  workers: MeshRelayPeerIdentity[];
  nodeIds: Set<string>;
  fingerprints: Set<string>;
  timer: ReturnType<typeof setTimeout>;
}

interface RelayControlConnection {
  id: string;
  socket: MeshRelaySocket;
  challenge: RelayChallengeState;
  authTimer: ReturnType<typeof setTimeout>;
  role?: MeshRelayPeerRole;
  identity?: MeshRelayPeerIdentity;
  workerStatus?: MeshRelayWorkerStatus;
  pendingAdmissionNonce?: string;
  pendingAdmissionTimer?: ReturnType<typeof setTimeout>;
  authorizationTransaction?: RelayAuthorizationTransaction;
  lastHeartbeatAt: number;
  protocolVersion: RelayProtocolVersion;
}

type RelayProtocolVersion =
  typeof MESH_PROTOCOL_VERSION;

interface ValidatedStreamRequest {
  requestId: string;
  targetNodeId: string;
  kind: MeshRelayStreamKind;
  method?: string;
  path: string;
  auditPath: string;
  headers: Record<string, string>;
}

type RelayTicketSide = "initiator" | "receiver";

interface RelayTicket {
  id: string;
  streamId: string;
  request: ValidatedStreamRequest;
  initiatorConnectionId: string;
  receiverConnectionId: string;
  initiatorNodeId: string;
  receiverNodeId: string;
  initiatorCredential?: string;
  receiverCredential?: string;
  initiatorReservationId?: string;
  receiverReservationId?: string;
  initiatorSocket?: MeshRelaySocket;
  receiverSocket?: MeshRelaySocket;
  expiresAt: string;
  timer: ReturnType<typeof setTimeout>;
  createdAt: number;
}

interface RelayDataReservation {
  id: string;
  ticketId: string;
  side: RelayTicketSide;
}

interface RelayDataConnection {
  id: string;
  streamId: string;
  side: RelayTicketSide;
  socket: MeshRelaySocket;
  protocolVersion: RelayProtocolVersion;
}

interface RelayLiveStream {
  id: string;
  request: ValidatedStreamRequest;
  initiatorConnectionId: string;
  receiverConnectionId: string;
  initiatorNodeId: string;
  receiverNodeId: string;
  initiatorDataId: string;
  receiverDataId: string;
  initiatorSocket: MeshRelaySocket;
  receiverSocket: MeshRelaySocket;
  startedAt: number;
  bytesToInitiator: number;
  bytesToReceiver: number;
  status?: number;
}

export interface MeshRelayDataReservation {
  reservationId: string;
}

class RelayRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function encodedBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function dataBytes(value: string | Uint8Array): number {
  return typeof value === "string" ? encodedBytes(value) : value.byteLength;
}

function identitiesMatch(
  left: MeshRelayPeerIdentity,
  right: MeshRelayPeerIdentity,
): boolean {
  return left.nodeId === right.nodeId
    && left.publicKey === right.publicKey
    && left.fingerprint === right.fingerprint;
}

function controlDisconnectOutcome(code: number): string {
  if (code === 1000) return "normal";
  if (code === MESH_RELAY_CONTROL_CLOSE_REPLACED) return "replaced";
  if (code === CONTROL_CLOSE_TIMEOUT) return "timeout";
  if (code === CONTROL_CLOSE_CAPACITY) return "capacity";
  if (code === 1012) return "server_shutdown";
  return "disconnected";
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  let totalBytes = 0;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (
      !/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name)
      || PROHIBITED_RELAY_HEADERS.has(name)
      || name.startsWith("proxy-")
    ) {
      throw new RelayRequestError(
        "relay_header_forbidden",
        `The relay header "${rawName}" is not allowed.`,
        400,
      );
    }
    if (Object.hasOwn(sanitized, name)) {
      throw new RelayRequestError(
        "relay_header_duplicate",
        `The relay header "${rawName}" is duplicated after normalization.`,
        400,
      );
    }
    const value = rawValue.trim();
    if (/[\r\n\0]/.test(value)) {
      throw new RelayRequestError(
        "relay_header_invalid",
        `The relay header "${rawName}" contains invalid characters.`,
        400,
      );
    }
    totalBytes += encodedBytes(name) + encodedBytes(value);
    if (totalBytes > MESH_RELAY_MAX_HEADER_BYTES) {
      throw new RelayRequestError(
        "relay_headers_too_large",
        "The relay stream headers exceed the size limit.",
        413,
      );
    }
    sanitized[name] = value;
  }
  return sanitized;
}

function validateRelativePath(value: string): {
  path: string;
  pathname: string;
  hasQuery: boolean;
} {
  if (
    value.includes("\\")
    || value.includes("#")
    || /[\u0000-\u001f\u007f]/.test(value)
    || value.startsWith("//")
    || /^[a-z][a-z0-9+.-]*:/i.test(value)
  ) {
    throw new RelayRequestError(
      "relay_path_invalid",
      "The relay path must be a relative Mesh API path.",
      400,
    );
  }
  const rawPathname = value.split("?", 1)[0]!;
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(rawPathname);
  } catch {
    throw new RelayRequestError(
      "relay_path_invalid",
      "The relay path contains invalid percent encoding.",
      400,
    );
  }
  if (
    /%2f|%5c/i.test(rawPathname)
    || decodedPathname.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new RelayRequestError(
      "relay_path_invalid",
      "The relay path must not contain encoded separators or dot segments.",
      400,
    );
  }
  const path = value.startsWith("/") ? value : `/${value}`;
  const parsed = new URL(path, "https://relay.invalid");
  if (
    parsed.origin !== "https://relay.invalid"
    || parsed.username
    || parsed.password
    || parsed.pathname.includes("/../")
    || parsed.pathname.includes("/./")
  ) {
    throw new RelayRequestError(
      "relay_path_invalid",
      "The relay path must be a relative Mesh API path.",
      400,
    );
  }
  return {
    path: `${parsed.pathname}${parsed.search}`,
    pathname: parsed.pathname,
    hasQuery: parsed.search.length > 0,
  };
}

function streamAuditResult(code: number): {
  outcome: string;
  errorCode?: string;
} {
  switch (code) {
    case 1000:
      return { outcome: "completed" };
    case MESH_RELAY_STREAM_CLOSE_CANCELLED:
      return {
        outcome: "cancelled",
        errorCode: "relay_stream_cancelled",
      };
    case MESH_RELAY_STREAM_CLOSE_TIMEOUT:
    case 4_913:
      return {
        outcome: "timed_out",
        errorCode: "relay_stream_timeout",
      };
    case MESH_RELAY_STREAM_CLOSE_PROTOCOL_ERROR:
    case 4_909:
      return {
        outcome: "protocol_failed",
        errorCode: "relay_stream_protocol_failed",
      };
    case MESH_RELAY_STREAM_CLOSE_DISPATCH_FAILED:
      return {
        outcome: "dispatch_failed",
        errorCode: "relay_stream_dispatch_failed",
      };
    case MESH_RELAY_STREAM_CLOSE_REQUEST_FAILED:
    case 4_911:
      return {
        outcome: "failed",
        errorCode: "relay_stream_failed",
      };
    default:
      return {
        outcome: "disconnected",
        errorCode: `websocket_${String(code)}`,
      };
  }
}

function validateStreamRoute(
  connection: RelayControlConnection,
  request: MeshRelayStreamRequestFrame,
): ValidatedStreamRequest {
  if (!connection.role || !connection.identity) {
    throw new RelayRequestError(
      "relay_auth_required",
      "Authenticate the relay control connection first.",
      401,
    );
  }
  const route = validateRelativePath(request.path);
  const method = request.method?.toUpperCase();
  if (request.kind === "http" && !method) {
    throw new RelayRequestError(
      "relay_method_required",
      "HTTP relay streams require a method.",
      400,
    );
  }
  if (request.kind === "socket" && request.method !== undefined) {
    throw new RelayRequestError(
      "relay_method_forbidden",
      "Socket relay streams must not include an HTTP method.",
      400,
    );
  }
  if (route.hasQuery && route.pathname !== MESH_RELAY_QUERY_ROUTE) {
    throw new RelayRequestError(
      "relay_query_forbidden",
      "Query strings are allowed only for Mesh execution file requests.",
      403,
    );
  }

  if (connection.role === "worker") {
    if (
      request.kind !== "http"
      || method !== "POST"
      || route.pathname !== "/api/mesh/internal/enrollment"
      || route.hasQuery
    ) {
      throw new RelayRequestError(
        "relay_route_forbidden",
        "Workers may use the relay only for enrollment.",
        403,
      );
    }
  } else if (request.kind === "http") {
    if (!CONTROLLER_HTTP_ROUTES.get(route.pathname)?.has(method!)) {
      throw new RelayRequestError(
        "relay_route_forbidden",
        "The requested Mesh HTTP route is not allowed through the relay.",
        403,
      );
    }
  } else if (!CONTROLLER_SOCKET_ROUTES.has(route.pathname) || route.hasQuery) {
    throw new RelayRequestError(
      "relay_route_forbidden",
      "The requested Mesh socket route is not allowed through the relay.",
      403,
    );
  }

  return {
    requestId: request.requestId,
    targetNodeId: request.targetNodeId,
    kind: request.kind,
    ...(method ? { method } : {}),
    path: route.path,
    auditPath: route.pathname,
    headers: sanitizeHeaders(request.headers),
  };
}

export class MeshRelayBroker {
  private readonly controls = new Map<string, RelayControlConnection>();
  private readonly workerConnections = new Map<string, string>();
  private readonly tickets = new Map<string, RelayTicket>();
  private readonly reservations = new Map<string, RelayDataReservation>();
  private readonly dataConnections = new Map<string, RelayDataConnection>();
  private readonly streams = new Map<string, RelayLiveStream>();
  private readonly pendingAdmissions = new Map<string, {
    identity: MeshRelayPeerIdentity;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly heartbeatTimer: ReturnType<typeof setInterval>;
  private controllerConnectionId?: string;
  private stopped = false;

  constructor(
    private readonly options: {
      identity: MeshRelaySigningIdentity;
      store: MeshRelayStore;
      controllerFingerprint: string;
      authorizationTransactionTimeoutMs?: number;
    },
  ) {
    this.heartbeatTimer = setInterval(
      () => this.heartbeat(),
      RELAY_HEARTBEAT_INTERVAL_MS,
    );
  }

  get connectionCount(): number {
    let attachingDataSockets = 0;
    for (const ticket of this.tickets.values()) {
      if (ticket.initiatorSocket) attachingDataSockets++;
      if (ticket.receiverSocket) attachingDataSockets++;
    }
    return this.controls.size + this.dataConnections.size + attachingDataSockets;
  }

  openControl(
    socket: MeshRelaySocket,
    protocolVersion: RelayProtocolVersion = MESH_PROTOCOL_VERSION,
  ): string {
    this.assertRunning();
    if (this.connectionCount >= RELAY_MAX_CONNECTIONS) {
      socket.close(CONTROL_CLOSE_CAPACITY, "Relay connection capacity exceeded");
      throw new RelayRequestError(
        "relay_capacity_exceeded",
        "Relay connection capacity exceeded.",
        429,
      );
    }
    const id = randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(
      issuedAt.getTime() + RELAY_CHALLENGE_LIFETIME_MS,
    ).toISOString();
    const challenge: RelayChallengeState = {
      challengeId: randomUUID(),
      nonce: randomToken(),
      expiresAt,
    };
    const authTimer = setTimeout(() => {
      this.closeControl(id, CONTROL_CLOSE_TIMEOUT, "Relay authentication timed out");
    }, RELAY_AUTH_TIMEOUT_MS);
    const connection: RelayControlConnection = {
      id,
      socket,
      challenge,
      authTimer,
      lastHeartbeatAt: Date.now(),
      protocolVersion,
    };
    this.controls.set(id, connection);
    const unsignedChallenge = {
      protocolVersion: connection.protocolVersion,
      type: "challenge",
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      relayPublicKey: this.options.identity.publicKey,
      relayFingerprint: this.options.identity.fingerprint,
      issuedAt: issuedAt.toISOString(),
      expiresAt,
    } as const;
    const frame: MeshRelayChallengeFrame = {
      ...unsignedChallenge,
      signature: this.options.identity.sign(
        buildMeshRelayChallengeSigningPayload(unsignedChallenge),
      ),
    };
    try {
      this.sendControl(connection, frame);
      if (!this.controls.has(id)) {
        throw new Error("The relay challenge could not be sent.");
      }
      logRelayAudit({
        eventType: "peer.connect",
        connectionId: id,
        outcome: "challenge_sent",
      });
      return id;
    } catch (error) {
      clearTimeout(authTimer);
      this.controls.delete(id);
      socket.close(1011, "Relay connection initialization failed");
      throw error;
    }
  }

  handleControlMessage(connectionId: string, message: string | Uint8Array): void {
    const connection = this.controls.get(connectionId);
    if (!connection) {
      return;
    }
    if (typeof message !== "string") {
      this.closeControl(
        connectionId,
        CONTROL_CLOSE_INVALID,
        "Relay control frames must be JSON text",
      );
      return;
    }
    if (encodedBytes(message) > RELAY_MAX_CONTROL_FRAME_BYTES) {
      this.closeControl(
        connectionId,
        1009,
        "Relay control frame exceeds the size limit",
      );
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      this.closeControl(connectionId, CONTROL_CLOSE_INVALID, "Malformed relay JSON frame");
      return;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      this.closeControl(connectionId, CONTROL_CLOSE_INVALID, "Invalid relay control frame");
      return;
    }
    const record = raw as Record<string, unknown>;
    if (record["protocolVersion"] !== connection.protocolVersion) {
      this.closeControl(
        connectionId,
        CONTROL_CLOSE_INVALID,
        "Unsupported relay protocol version",
      );
      return;
    }
    const type = record["type"];
    if (typeof type !== "string") {
      this.closeControl(connectionId, CONTROL_CLOSE_INVALID, "Relay frame type is required");
      return;
    }
    try {
      if (type === "auth") {
        const parsed = MeshRelayAuthFrameSchema.safeParse(raw);
        if (!parsed.success) throw new Error(parsed.error.message);
        this.authenticate(connection, parsed.data);
        return;
      }
      if (!connection.identity) {
        throw new RelayRequestError(
          "relay_auth_required",
          "Authenticate the relay control connection first.",
          401,
        );
      }
      connection.lastHeartbeatAt = Date.now();
      if (type === "authorization.begin") {
        const parsed = MeshRelayAuthorizationBeginFrameSchema.safeParse(raw);
        if (!parsed.success) throw new Error(parsed.error.message);
        this.beginAuthorization(connection, parsed.data);
        return;
      }
      if (type === "authorization.chunk") {
        const parsed = MeshRelayAuthorizationChunkFrameSchema.safeParse(raw);
        if (!parsed.success) throw new Error(parsed.error.message);
        this.stageAuthorizationChunk(connection, parsed.data);
        return;
      }
      if (type === "authorization.commit") {
        const parsed = MeshRelayAuthorizationCommitFrameSchema.safeParse(raw);
        if (!parsed.success) throw new Error(parsed.error.message);
        this.commitAuthorization(connection, parsed.data);
        return;
      }
      if (type === "stream.request") {
        const parsed = MeshRelayStreamRequestFrameSchema.safeParse(raw);
        if (!parsed.success) throw new Error(parsed.error.message);
        this.requestStream(connection, parsed.data);
        return;
      }
      if (type === "stream.cancel") {
        const parsed = MeshRelayStreamCancelFrameSchema.safeParse(raw);
        if (!parsed.success) throw new Error(parsed.error.message);
        this.cancelStreamRequest(connection, parsed.data.requestId);
        return;
      }
      if (type === "stream.status") {
        const parsed = MeshRelayStreamStatusFrameSchema.safeParse(raw);
        if (!parsed.success) throw new Error(parsed.error.message);
        this.setStreamStatus(connection, parsed.data.streamId, parsed.data.status);
        return;
      }
      if (type === "pong") {
        const parsed = MeshRelayPongFrameSchema.safeParse(raw);
        if (!parsed.success) throw new Error(parsed.error.message);
        return;
      }
      this.closeControl(connectionId, CONTROL_CLOSE_INVALID, "Unknown relay frame type");
    } catch (error) {
      if (type.startsWith("authorization.")) {
        this.discardAuthorizationTransaction(connection);
      }
      if (error instanceof RelayRequestError) {
        const requestId = typeof record["requestId"] === "string"
          ? record["requestId"]
          : typeof record["transactionId"] === "string"
            ? record["transactionId"]
            : typeof record["streamId"] === "string"
              ? record["streamId"]
              : "";
        if (requestId) {
          this.sendStreamError(connection, requestId, error);
          return;
        }
      }
      log.warn("Closing malformed relay control connection", {
        connectionId,
        error: String(error),
      });
      this.closeControl(connectionId, CONTROL_CLOSE_INVALID, "Invalid relay control frame");
    }
  }

  private authenticate(
    connection: RelayControlConnection,
    auth: MeshRelayAuthFrame,
  ): void {
    if (connection.identity) {
      throw new RelayRequestError(
        "relay_already_authenticated",
        "The relay control connection is already authenticated.",
        409,
      );
    }
    const now = Date.now();
    if (
      auth.challengeId !== connection.challenge.challengeId
      || auth.nonce !== connection.challenge.nonce
      || auth.expiresAt !== connection.challenge.expiresAt
      || auth.relayFingerprint !== this.options.identity.fingerprint
      || now > Date.parse(auth.expiresAt)
    ) {
      this.auditAuthFailure(connection, auth, "relay_challenge_invalid");
      this.closeControl(
        connection.id,
        CONTROL_CLOSE_UNAUTHORIZED,
        "Relay challenge validation failed",
      );
      return;
    }
    let derivedFingerprint: string;
    try {
      derivedFingerprint = getMeshRelayFingerprint(auth.publicKey);
    } catch (error) {
      this.auditAuthFailure(connection, auth, "relay_identity_invalid");
      log.debug("Relay peer public-key validation detail", {
        connectionId: connection.id,
        error: String(error),
      });
      this.closeControl(
        connection.id,
        CONTROL_CLOSE_UNAUTHORIZED,
        "Relay peer identity is invalid",
      );
      return;
    }
    if (
      derivedFingerprint !== auth.fingerprint
      || !verifyMeshRelaySignature(
        buildMeshRelayAuthSigningPayload(auth),
        auth.signature,
        auth.publicKey,
      )
    ) {
      this.auditAuthFailure(connection, auth, "relay_signature_invalid");
      this.closeControl(
        connection.id,
        CONTROL_CLOSE_UNAUTHORIZED,
        "Relay peer signature validation failed",
      );
      return;
    }
    const identity: MeshRelayPeerIdentity = {
      nodeId: auth.nodeId,
      publicKey: auth.publicKey,
      fingerprint: auth.fingerprint,
    };
    clearTimeout(connection.authTimer);
    connection.role = auth.role;
    connection.identity = identity;
    connection.lastHeartbeatAt = now;

    if (auth.role === "controller") {
      if (auth.enrollmentAdmission) {
        this.auditAuthFailure(connection, auth, "relay_controller_admission_invalid");
        this.closeControl(
          connection.id,
          CONTROL_CLOSE_INVALID,
          "Controller authentication must not include worker admission",
        );
        return;
      }
      if (auth.fingerprint !== this.options.controllerFingerprint) {
        this.auditAuthFailure(connection, auth, "relay_controller_untrusted");
        this.closeControl(
          connection.id,
          CONTROL_CLOSE_UNAUTHORIZED,
          "Controller fingerprint is not trusted",
        );
        return;
      }
      this.options.store.pairController(identity);
      const previousId = this.controllerConnectionId;
      this.controllerConnectionId = connection.id;
      if (previousId && previousId !== connection.id) {
        this.closeControl(
          previousId,
          MESH_RELAY_CONTROL_CLOSE_REPLACED,
          "Controller connection replaced",
        );
      }
    } else {
      const authorized = this.options.store.getAuthorizedWorker(identity.nodeId);
      if (authorized && !identitiesMatch(authorized, identity)) {
        this.auditAuthFailure(connection, auth, "relay_worker_identity_mismatch");
        this.closeControl(
          connection.id,
          CONTROL_CLOSE_UNAUTHORIZED,
          "Worker identity does not match relay authorization",
        );
        return;
      }
      const admission = authorized
        ? undefined
        : verifyMeshRelayEnrollmentAdmission(
          auth.enrollmentAdmission,
          this.options.store.getController(),
          now,
        );
      if (!authorized && !admission) {
        this.auditAuthFailure(connection, auth, "relay_worker_admission_invalid");
        this.closeControl(
          connection.id,
          CONTROL_CLOSE_UNAUTHORIZED,
          "Worker enrollment admission is invalid or expired",
        );
        return;
      }
      if (admission) {
        const claim = this.pendingAdmissions.get(admission.nonce);
        if (claim && !identitiesMatch(claim.identity, identity)) {
          this.auditAuthFailure(connection, auth, "relay_worker_admission_in_use");
          this.closeControl(
            connection.id,
            CONTROL_CLOSE_UNAUTHORIZED,
            "Worker enrollment admission is already in use",
          );
          return;
        }
        if (!claim) {
          const claimTimer = setTimeout(() => {
            this.pendingAdmissions.delete(admission.nonce);
          }, Math.max(0, Date.parse(admission.expiresAt) - now));
          claimTimer.unref?.();
          this.pendingAdmissions.set(admission.nonce, {
            identity,
            timer: claimTimer,
          });
        }
        connection.pendingAdmissionNonce = admission.nonce;
        connection.pendingAdmissionTimer = setTimeout(() => {
          const current = this.controls.get(connection.id);
          if (current?.workerStatus === "pending") {
            this.closeControl(
              connection.id,
              CONTROL_CLOSE_TIMEOUT,
              "Worker enrollment admission expired",
            );
          }
        }, Math.max(0, Date.parse(admission.expiresAt) - now));
        connection.pendingAdmissionTimer.unref?.();
      }
      connection.workerStatus = authorized ? "authorized" : "pending";
      if (
        connection.workerStatus === "pending"
        && this.pendingWorkerCount() > RELAY_MAX_PENDING_WORKERS
      ) {
        this.closeControl(
          connection.id,
          CONTROL_CLOSE_CAPACITY,
          "Pending worker capacity exceeded",
        );
        return;
      }
      const previousId = this.workerConnections.get(identity.nodeId);
      this.workerConnections.set(identity.nodeId, connection.id);
      if (previousId && previousId !== connection.id) {
        this.closeControl(
          previousId,
          MESH_RELAY_CONTROL_CLOSE_REPLACED,
          "Worker connection replaced",
        );
      }
    }

    const frame: MeshRelayAuthOkFrame = {
      protocolVersion: connection.protocolVersion,
      type: "auth.ok",
      connectionId: connection.id,
      role: auth.role,
      nodeId: auth.nodeId,
      ...(connection.workerStatus
        ? { workerStatus: connection.workerStatus }
        : {}),
    };
    this.sendControl(connection, frame);
    logRelayAudit({
      eventType: "peer.auth",
      connectionId: connection.id,
      role: auth.role,
      nodeId: auth.nodeId,
      outcome: connection.workerStatus ?? "authorized",
    });
  }

  private auditAuthFailure(
    connection: RelayControlConnection,
    auth: { role: MeshRelayPeerRole; nodeId: string },
    errorCode: string,
  ): void {
    logRelayAudit({
      eventType: "peer.auth",
      connectionId: connection.id,
      role: auth.role,
      nodeId: auth.nodeId,
      outcome: "rejected",
      errorCode,
    });
  }

  private assertControllerAuthorization(
    controller: RelayControlConnection,
  ): void {
    if (controller.role !== "controller") {
      throw new RelayRequestError(
        "relay_authorization_forbidden",
        "Only the controller may replace relay worker authorization.",
        403,
      );
    }
  }

  private beginAuthorization(
    controller: RelayControlConnection,
    frame: MeshRelayAuthorizationBeginFrame,
  ): void {
    this.assertControllerAuthorization(controller);
    this.discardAuthorizationTransaction(controller);
    if (frame.workerCount > MESH_RELAY_MAX_AUTHORIZED_WORKERS) {
      throw new RelayRequestError(
        "relay_authorization_too_many_workers",
        "The relay authorization snapshot exceeds the worker limit.",
        413,
      );
    }
    if (frame.identityBytes > MESH_RELAY_MAX_AUTHORIZATION_STAGED_BYTES) {
      throw new RelayRequestError(
        "relay_authorization_too_large",
        "The relay authorization snapshot exceeds the staged byte limit.",
        413,
      );
    }
    const timer = setTimeout(() => {
      const current = this.controls.get(controller.id);
      if (
        current?.authorizationTransaction?.transactionId
        === frame.transactionId
      ) {
        this.discardAuthorizationTransaction(current);
      }
    }, this.options.authorizationTransactionTimeoutMs
      ?? RELAY_AUTHORIZATION_TRANSACTION_TIMEOUT_MS);
    timer.unref?.();
    controller.authorizationTransaction = {
      transactionId: frame.transactionId,
      workerCount: frame.workerCount,
      identityBytes: frame.identityBytes,
      stagedBytes: 0,
      workers: [],
      nodeIds: new Set<string>(),
      fingerprints: new Set<string>(),
      timer,
    };
  }

  private stageAuthorizationChunk(
    controller: RelayControlConnection,
    frame: MeshRelayAuthorizationChunkFrame,
  ): void {
    this.assertControllerAuthorization(controller);
    const transaction = this.requireAuthorizationTransaction(
      controller,
      frame.transactionId,
    );
    for (const worker of frame.workers) {
      let fingerprint: string;
      try {
        fingerprint = getMeshRelayFingerprint(worker.publicKey);
      } catch (error) {
        throw new RelayRequestError(
          "relay_worker_identity_invalid",
          `Worker "${worker.nodeId}" has an invalid public key: ${String(error)}`,
          400,
        );
      }
      if (
        fingerprint !== worker.fingerprint
        || transaction.nodeIds.has(worker.nodeId)
        || transaction.fingerprints.has(worker.fingerprint)
      ) {
        throw new RelayRequestError(
          "relay_worker_identity_invalid",
          `Worker "${worker.nodeId}" has an invalid or duplicate identity.`,
          400,
        );
      }
      const identityBytes = encodedBytes(JSON.stringify(worker));
      if (
        transaction.workers.length + 1 > transaction.workerCount
        || transaction.workers.length + 1 > MESH_RELAY_MAX_AUTHORIZED_WORKERS
      ) {
        throw new RelayRequestError(
          "relay_authorization_too_many_workers",
          "The relay authorization transaction exceeds its worker count.",
          413,
        );
      }
      if (
        transaction.stagedBytes + identityBytes > transaction.identityBytes
        || transaction.stagedBytes + identityBytes
          > MESH_RELAY_MAX_AUTHORIZATION_STAGED_BYTES
      ) {
        throw new RelayRequestError(
          "relay_authorization_too_large",
          "The relay authorization transaction exceeds its staged byte limit.",
          413,
        );
      }
      transaction.nodeIds.add(worker.nodeId);
      transaction.fingerprints.add(worker.fingerprint);
      transaction.workers.push(worker);
      transaction.stagedBytes += identityBytes;
    }
  }

  private commitAuthorization(
    controller: RelayControlConnection,
    frame: MeshRelayAuthorizationCommitFrame,
  ): void {
    this.assertControllerAuthorization(controller);
    const transaction = this.requireAuthorizationTransaction(
      controller,
      frame.transactionId,
    );
    if (
      transaction.workers.length !== transaction.workerCount
      || transaction.stagedBytes !== transaction.identityBytes
    ) {
      throw new RelayRequestError(
        "relay_authorization_incomplete",
        "The relay authorization transaction is incomplete.",
        409,
      );
    }
    const workers = transaction.workers;
    this.discardAuthorizationTransaction(controller);
    this.options.store.replaceAuthorizedWorkers(workers);
    const authorizedByNodeId = new Map(
      workers.map((worker) => [worker.nodeId, worker]),
    );
    for (const connection of [...this.controls.values()]) {
      if (connection.role !== "worker" || !connection.identity) {
        continue;
      }
      const authorized = authorizedByNodeId.get(connection.identity.nodeId);
      if (authorized && identitiesMatch(authorized, connection.identity)) {
        const wasPending = connection.workerStatus === "pending";
        connection.workerStatus = "authorized";
        if (wasPending) {
          this.releasePendingAdmission(connection);
          this.sendControl(connection, {
            protocolVersion: connection.protocolVersion,
            type: "auth.ok",
            connectionId: connection.id,
            role: "worker",
            nodeId: connection.identity.nodeId,
            workerStatus: "authorized",
          });
        }
        continue;
      }
      if (!authorized && connection.workerStatus === "pending") {
        continue;
      }
      this.closeControl(
        connection.id,
        CONTROL_CLOSE_UNAUTHORIZED,
        authorized ? "Worker identity changed" : "Worker authorization revoked",
      );
    }
    this.sendControl(controller, {
      protocolVersion: controller.protocolVersion,
      type: "authorization.ack",
      transactionId: frame.transactionId,
      workerCount: workers.length,
    });
    logRelayAudit({
      eventType: "authorization.replace",
      role: "controller",
      nodeId: controller.identity?.nodeId,
      connectionId: controller.id,
      outcome: "accepted",
    });
  }

  private requireAuthorizationTransaction(
    controller: RelayControlConnection,
    transactionId: string,
  ): RelayAuthorizationTransaction {
    const transaction = controller.authorizationTransaction;
    if (!transaction || transaction.transactionId !== transactionId) {
      throw new RelayRequestError(
        "relay_authorization_transaction_missing",
        "The relay authorization transaction is missing or expired.",
        409,
      );
    }
    return transaction;
  }

  private discardAuthorizationTransaction(
    controller: RelayControlConnection,
  ): void {
    const transaction = controller.authorizationTransaction;
    if (!transaction) {
      return;
    }
    clearTimeout(transaction.timer);
    controller.authorizationTransaction = undefined;
  }

  private requestStream(
    initiator: RelayControlConnection,
    input: MeshRelayStreamRequestFrame,
  ): void {
    const request = validateStreamRoute(initiator, input);
    const receiver = this.resolveReceiver(initiator, request.targetNodeId);
    this.assertNodeCapacity(initiator.id);
    this.assertNodeCapacity(receiver.id);

    const ticketId = randomToken();
    const streamId = randomUUID();
    const initiatorCredential = randomToken();
    const receiverCredential = randomToken();
    const expiresAt = new Date(Date.now() + RELAY_TICKET_LIFETIME_MS).toISOString();
    const ticket: RelayTicket = {
      id: ticketId,
      streamId,
      request,
      initiatorConnectionId: initiator.id,
      receiverConnectionId: receiver.id,
      initiatorNodeId: initiator.identity!.nodeId,
      receiverNodeId: receiver.identity!.nodeId,
      initiatorCredential,
      receiverCredential,
      expiresAt,
      timer: setTimeout(() => {
        this.cancelTicket(ticketId, 4410, "Relay stream ticket expired");
      }, RELAY_TICKET_LIFETIME_MS),
      createdAt: Date.now(),
    };
    this.tickets.set(ticketId, ticket);

    const initiatorFrame: MeshRelayStreamTicketFrame = {
      protocolVersion: initiator.protocolVersion,
      type: "stream.ticket",
      requestId: request.requestId,
      streamId,
      ticket: ticketId,
      credential: initiatorCredential,
      expiresAt,
    };
    const receiverFrame: MeshRelayStreamOfferFrame = {
      protocolVersion: receiver.protocolVersion,
      type: "stream.offer",
      requestId: request.requestId,
      streamId,
      ticket: ticketId,
      credential: receiverCredential,
      expiresAt,
      initiatorNodeId: initiator.identity!.nodeId,
      kind: request.kind,
      ...(request.method ? { method: request.method } : {}),
      path: request.path,
      headers: request.headers,
    };
    this.sendControl(initiator, initiatorFrame);
    if (!this.tickets.has(ticketId)) {
      return;
    }
    this.sendControl(receiver, receiverFrame);
  }

  private cancelStreamRequest(
    initiator: RelayControlConnection,
    requestId: string,
  ): void {
    for (const ticket of this.tickets.values()) {
      if (
        ticket.initiatorConnectionId === initiator.id
        && ticket.request.requestId === requestId
      ) {
        this.cancelTicket(
          ticket.id,
          MESH_RELAY_STREAM_CLOSE_CANCELLED,
          "Relay stream request cancelled",
        );
        return;
      }
    }
    for (const stream of this.streams.values()) {
      if (
        stream.initiatorConnectionId === initiator.id
        && stream.request.requestId === requestId
      ) {
        this.closeStream(
          stream.id,
          MESH_RELAY_STREAM_CLOSE_CANCELLED,
          "Relay stream request cancelled",
        );
        return;
      }
    }
  }

  private releasePendingAdmission(connection: RelayControlConnection): void {
    if (connection.pendingAdmissionTimer) {
      clearTimeout(connection.pendingAdmissionTimer);
      connection.pendingAdmissionTimer = undefined;
    }
    connection.pendingAdmissionNonce = undefined;
  }

  private resolveReceiver(
    initiator: RelayControlConnection,
    targetNodeId: string,
  ): RelayControlConnection {
    if (initiator.role === "worker") {
      const controller = this.controllerConnectionId
        ? this.controls.get(this.controllerConnectionId)
        : undefined;
      if (
        !controller
        || controller.role !== "controller"
        || controller.identity?.nodeId !== targetNodeId
      ) {
        throw new RelayRequestError(
          "relay_target_disconnected",
          "The relay controller target is disconnected.",
          503,
        );
      }
      return controller;
    }
    const workerConnectionId = this.workerConnections.get(targetNodeId);
    const worker = workerConnectionId
      ? this.controls.get(workerConnectionId)
      : undefined;
    if (!worker) {
      throw new RelayRequestError(
        "relay_target_disconnected",
        "The relay worker target is disconnected.",
        503,
      );
    }
    if (worker.workerStatus !== "authorized") {
      throw new RelayRequestError(
        "relay_target_unauthorized",
        "The relay worker target is not authorized.",
        403,
      );
    }
    return worker;
  }

  private assertNodeCapacity(connectionId: string): void {
    let tickets = 0;
    for (const ticket of this.tickets.values()) {
      if (
        ticket.initiatorConnectionId === connectionId
        || ticket.receiverConnectionId === connectionId
      ) {
        tickets++;
      }
    }
    if (tickets >= RELAY_MAX_TICKETS_PER_NODE) {
      throw new RelayRequestError(
        "relay_ticket_capacity_exceeded",
        "The relay peer has too many pending stream tickets.",
        429,
      );
    }
    let streams = 0;
    for (const stream of this.streams.values()) {
      if (
        stream.initiatorConnectionId === connectionId
        || stream.receiverConnectionId === connectionId
      ) {
        streams++;
      }
    }
    if (streams >= RELAY_MAX_STREAMS_PER_NODE) {
      throw new RelayRequestError(
        "relay_stream_capacity_exceeded",
        "The relay peer has too many active streams.",
        429,
      );
    }
  }

  reserveDataSocket(
    ticketId: string,
    credential: string,
  ): MeshRelayDataReservation | undefined {
    this.assertRunning();
    if (this.connectionCount >= RELAY_MAX_CONNECTIONS) {
      return undefined;
    }
    const ticket = this.tickets.get(ticketId);
    if (!ticket || Date.now() > Date.parse(ticket.expiresAt)) {
      return undefined;
    }
    let side: RelayTicketSide;
    if (ticket.initiatorCredential === credential) {
      side = "initiator";
      ticket.initiatorCredential = undefined;
    } else if (ticket.receiverCredential === credential) {
      side = "receiver";
      ticket.receiverCredential = undefined;
    } else {
      return undefined;
    }
    const reservationId = randomUUID();
    const reservation: RelayDataReservation = {
      id: reservationId,
      ticketId,
      side,
    };
    this.reservations.set(reservationId, reservation);
    if (side === "initiator") {
      ticket.initiatorReservationId = reservationId;
    } else {
      ticket.receiverReservationId = reservationId;
    }
    return { reservationId };
  }

  attachDataSocket(reservationId: string, socket: MeshRelaySocket): void {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      socket.close(CONTROL_CLOSE_UNAUTHORIZED, "Invalid relay stream reservation");
      return;
    }
    const ticket = this.tickets.get(reservation.ticketId);
    if (!ticket) {
      this.reservations.delete(reservationId);
      socket.close(CONTROL_CLOSE_TIMEOUT, "Relay stream ticket expired");
      return;
    }
    if (this.connectionCount >= RELAY_MAX_CONNECTIONS) {
      this.cancelTicket(
        ticket.id,
        CONTROL_CLOSE_CAPACITY,
        "Relay connection capacity exceeded",
      );
      socket.close(CONTROL_CLOSE_CAPACITY, "Relay connection capacity exceeded");
      return;
    }
    if (reservation.side === "initiator") {
      ticket.initiatorSocket = socket;
    } else {
      ticket.receiverSocket = socket;
    }
    if (!ticket.initiatorSocket || !ticket.receiverSocket) {
      return;
    }
    const initiatorDataId = ticket.initiatorReservationId!;
    const receiverDataId = ticket.receiverReservationId!;
    clearTimeout(ticket.timer);
    this.tickets.delete(ticket.id);
    this.reservations.delete(initiatorDataId);
    this.reservations.delete(receiverDataId);
    const stream: RelayLiveStream = {
      id: ticket.streamId,
      request: ticket.request,
      initiatorConnectionId: ticket.initiatorConnectionId,
      receiverConnectionId: ticket.receiverConnectionId,
      initiatorNodeId: ticket.initiatorNodeId,
      receiverNodeId: ticket.receiverNodeId,
      initiatorDataId,
      receiverDataId,
      initiatorSocket: ticket.initiatorSocket,
      receiverSocket: ticket.receiverSocket,
      startedAt: Date.now(),
      bytesToInitiator: 0,
      bytesToReceiver: 0,
    };
    this.streams.set(stream.id, stream);
    const initiatorConnection = this.controls.get(ticket.initiatorConnectionId);
    const receiverConnection = this.controls.get(ticket.receiverConnectionId);
    if (!initiatorConnection || !receiverConnection) {
      this.closeStream(stream.id, 1011, "Relay control connection is unavailable");
      return;
    }
    this.dataConnections.set(initiatorDataId, {
      id: initiatorDataId,
      streamId: stream.id,
      side: "initiator",
      socket: stream.initiatorSocket,
      protocolVersion: initiatorConnection.protocolVersion,
    });
    this.dataConnections.set(receiverDataId, {
      id: receiverDataId,
      streamId: stream.id,
      side: "receiver",
      socket: stream.receiverSocket,
      protocolVersion: receiverConnection.protocolVersion,
    });
    const initiatorReady: MeshRelayStreamReadyFrame = {
      protocolVersion: initiatorConnection.protocolVersion,
      type: "stream.ready",
      requestId: stream.request.requestId,
      streamId: stream.id,
    };
    const receiverReady: MeshRelayStreamReadyFrame = {
      protocolVersion: receiverConnection.protocolVersion,
      type: "stream.ready",
      requestId: stream.request.requestId,
      streamId: stream.id,
    };
    this.sendData(
      stream,
      stream.initiatorSocket,
      JSON.stringify(initiatorReady),
    );
    if (this.streams.has(stream.id)) {
      this.sendData(
        stream,
        stream.receiverSocket,
        JSON.stringify(receiverReady),
      );
    }
  }

  handleDataMessage(
    dataConnectionId: string,
    message: string | Uint8Array,
  ): void {
    const connection = this.dataConnections.get(dataConnectionId);
    if (!connection) {
      return;
    }
    const stream = this.streams.get(connection.streamId);
    if (!stream) {
      return;
    }
    const bytes = dataBytes(message);
    if (bytes > RELAY_MAX_DATA_FRAME_BYTES) {
      this.closeStream(stream.id, 1009, "Relay data frame exceeds the size limit");
      return;
    }
    if (connection.side === "initiator") {
      stream.bytesToReceiver += bytes;
      this.sendData(stream, stream.receiverSocket, message);
    } else {
      stream.bytesToInitiator += bytes;
      this.sendData(stream, stream.initiatorSocket, message);
    }
  }

  private sendData(
    stream: RelayLiveStream,
    socket: MeshRelaySocket,
    message: string | Uint8Array,
  ): void {
    const bytes = dataBytes(message);
    if (
      socket.getBufferedAmount() > RELAY_MAX_QUEUED_BYTES
      || socket.getBufferedAmount() + bytes > RELAY_MAX_QUEUED_BYTES
    ) {
      this.closeStream(stream.id, 1013, "Relay stream backpressure limit exceeded");
      return;
    }
    const status = socket.send(message);
    if (status === 0) {
      this.closeStream(stream.id, 1011, "Relay stream send failed");
    }
  }

  private setStreamStatus(
    connection: RelayControlConnection,
    streamId: string,
    status: number,
  ): void {
    const stream = this.streams.get(streamId);
    // The HTTP response status is produced by the receiver of the stream, so
    // only the receiving connection may report it for the audit record.
    if (!stream || stream.receiverConnectionId !== connection.id) {
      throw new RelayRequestError(
        "relay_stream_not_found",
        "The relay stream does not belong to this connection.",
        404,
      );
    }
    stream.status = status;
  }

  closeData(dataConnectionId: string, code: number, reason: string): void {
    const connection = this.dataConnections.get(dataConnectionId);
    if (connection) {
      this.closeStream(connection.streamId, code, reason);
      return;
    }
    const reservation = this.reservations.get(dataConnectionId);
    if (reservation) {
      this.cancelTicket(reservation.ticketId, code, reason);
    }
  }

  private closeStream(streamId: string, code: number, reason: string): void {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return;
    }
    this.streams.delete(streamId);
    this.dataConnections.delete(stream.initiatorDataId);
    this.dataConnections.delete(stream.receiverDataId);
    stream.initiatorSocket.close(code, reason);
    stream.receiverSocket.close(code, reason);
    const audit = streamAuditResult(code);
    logRelayStreamAudit({
      streamId: stream.id,
      initiatorNodeId: stream.initiatorNodeId,
      targetNodeId: stream.receiverNodeId,
      kind: stream.request.kind,
      ...(stream.request.method ? { method: stream.request.method } : {}),
      path: stream.request.auditPath,
      ...(stream.status ? { status: stream.status } : {}),
      bytesToInitiator: stream.bytesToInitiator,
      bytesToReceiver: stream.bytesToReceiver,
      durationMs: Math.max(0, Date.now() - stream.startedAt),
      outcome: audit.outcome,
      ...(audit.errorCode ? { errorCode: audit.errorCode } : {}),
    });
  }

  private cancelTicket(ticketId: string, code: number, reason: string): void {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      return;
    }
    clearTimeout(ticket.timer);
    this.tickets.delete(ticketId);
    if (ticket.initiatorReservationId) {
      this.reservations.delete(ticket.initiatorReservationId);
    }
    if (ticket.receiverReservationId) {
      this.reservations.delete(ticket.receiverReservationId);
    }
    ticket.initiatorSocket?.close(code, reason);
    ticket.receiverSocket?.close(code, reason);
    const audit = streamAuditResult(code);
    logRelayStreamAudit({
      streamId: ticket.streamId,
      initiatorNodeId: ticket.initiatorNodeId,
      targetNodeId: ticket.receiverNodeId,
      kind: ticket.request.kind,
      ...(ticket.request.method ? { method: ticket.request.method } : {}),
      path: ticket.request.auditPath,
      bytesToInitiator: 0,
      bytesToReceiver: 0,
      durationMs: Math.max(0, Date.now() - ticket.createdAt),
      outcome: audit.outcome === "completed" || audit.outcome === "disconnected"
        ? "not_connected"
        : audit.outcome,
      errorCode: code === 4410
        ? "relay_ticket_expired"
        : audit.errorCode ?? "relay_stream_not_connected",
    });
  }

  handleControlClose(connectionId: string, code: number): void {
    this.closeControl(
      connectionId,
      code,
      code === 1000
        ? "Relay peer disconnected normally"
        : "Relay peer disconnected",
      false,
    );
  }

  closeControl(
    connectionId: string,
    code: number,
    reason: string,
    closeSocket = true,
  ): void {
    const connection = this.controls.get(connectionId);
    if (!connection) {
      return;
    }
    this.controls.delete(connectionId);
    clearTimeout(connection.authTimer);
    this.discardAuthorizationTransaction(connection);
    this.releasePendingAdmission(connection);
    if (this.controllerConnectionId === connectionId) {
      this.controllerConnectionId = undefined;
    }
    if (
      connection.identity
      && this.workerConnections.get(connection.identity.nodeId) === connectionId
    ) {
      this.workerConnections.delete(connection.identity.nodeId);
    }
    for (const ticket of [...this.tickets.values()]) {
      if (
        ticket.initiatorConnectionId === connectionId
        || ticket.receiverConnectionId === connectionId
      ) {
        this.cancelTicket(ticket.id, code, reason);
      }
    }
    for (const stream of [...this.streams.values()]) {
      if (
        stream.initiatorConnectionId === connectionId
        || stream.receiverConnectionId === connectionId
      ) {
        this.closeStream(stream.id, code, reason);
      }
    }
    if (closeSocket) {
      connection.socket.close(code, reason);
    }
    logRelayAudit({
      eventType: "peer.disconnect",
      connectionId,
      role: connection.role,
      nodeId: connection.identity?.nodeId,
      outcome: controlDisconnectOutcome(code),
      errorCode: code === 1000 ? undefined : `websocket_${String(code)}`,
    });
  }

  private sendStreamError(
    connection: RelayControlConnection,
    requestId: string,
    error: RelayRequestError,
  ): void {
    const frame: MeshRelayControlErrorFrame = {
      protocolVersion: connection.protocolVersion,
      type: "stream.error",
      requestId,
      code: error.code,
      message: error.message,
      status: error.status,
    };
    this.sendControl(connection, frame);
  }

  private sendControl(
    connection: RelayControlConnection,
    frame: MeshRelayServerControlFrame,
  ): void {
    const serialized = JSON.stringify(frame);
    if (
      connection.socket.getBufferedAmount() + encodedBytes(serialized)
      > RELAY_MAX_QUEUED_BYTES
    ) {
      this.closeControl(
        connection.id,
        CONTROL_CLOSE_CAPACITY,
        "Relay control backpressure limit exceeded",
      );
      return;
    }
    if (connection.socket.send(serialized) === 0) {
      this.closeControl(connection.id, 1011, "Relay control send failed");
    }
  }

  private heartbeat(): void {
    const now = Date.now();
    for (const connection of [...this.controls.values()]) {
      if (!connection.identity) {
        continue;
      }
      if (now - connection.lastHeartbeatAt > RELAY_HEARTBEAT_TIMEOUT_MS) {
        this.closeControl(
          connection.id,
          CONTROL_CLOSE_TIMEOUT,
          "Relay heartbeat timed out",
        );
        continue;
      }
      this.sendControl(connection, {
        protocolVersion: connection.protocolVersion,
        type: "heartbeat",
        sentAt: new Date(now).toISOString(),
      });
    }
  }

  private pendingWorkerCount(): number {
    let count = 0;
    for (const connection of this.controls.values()) {
      if (
        connection.role === "worker"
        && connection.workerStatus === "pending"
      ) {
        count++;
      }
    }
    return count;
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw new Error("The relay broker is stopped.");
    }
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    clearInterval(this.heartbeatTimer);
    for (const connection of [...this.controls.values()]) {
      this.closeControl(connection.id, 1012, "Relay server is stopping");
    }
    for (const ticket of [...this.tickets.values()]) {
      this.cancelTicket(ticket.id, 1012, "Relay server is stopping");
    }
    for (const stream of [...this.streams.values()]) {
      this.closeStream(stream.id, 1012, "Relay server is stopping");
    }
    for (const claim of this.pendingAdmissions.values()) {
      clearTimeout(claim.timer);
    }
    this.pendingAdmissions.clear();
  }
}

export { MeshRelayBroker as RelayBroker };
