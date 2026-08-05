/**
 * Internal, transport-neutral contracts for the ACP backend collaborators.
 *
 * These narrow interfaces let the facade compose focused services
 * (transport/lifecycle, RPC client, session state, session/protocol,
 * event translation/subscriptions, permissions, and capability/provider
 * adaptation) with strictly one-way dependencies. No collaborator imports the
 * `AcpBackend` facade; collaborators depend only on the interfaces declared
 * here plus the shared typed errors.
 */

import type { AgentProvider } from "@/shared/settings";
import type { AgentEvent, BackendConnectionConfig, ConnectionInfo } from "../types";
import type { JsonRpcMessage } from "./types";
import type { AcpError } from "./errors";

/**
 * Raw wire transport used by the RPC client to write outbound JSON-RPC
 * messages. Implementations may be local process pipes or remote sockets.
 */
export interface RpcTransport {
  /** Write one JSON-RPC message. Throws when the wire is unwritable. */
  write(message: JsonRpcMessage): void;
  /** Whether the transport currently accepts writes. */
  isWritable(): boolean;
  /**
   * Wait until the wire can accept another message.
   *
   * Local stdio transports resolve immediately. A remote transport may use
   * this hook to apply backpressure without making the RPC client aware of
   * its wire protocol.
   */
  waitForWritable?(signal?: AbortSignal): Promise<void>;
}

/**
 * Sink for inbound JSON-RPC notifications (method calls without a numeric
 * response correlation the RPC client should resolve). The RPC client routes
 * every server-initiated method message here.
 */
export type RpcNotificationSink = (message: JsonRpcMessage) => void;

/**
 * Minimal request surface the session, permission, and capability services
 * depend on. Implemented by the RPC client.
 */
export interface RpcRequester {
  sendRequest<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
  /** Write a raw JSON-RPC message (e.g. a response to an inbound request). */
  writeMessage(message: JsonRpcMessage): void;
}

export interface RpcPendingController {
  /** Reject all requests when the underlying wire closes. */
  rejectPending(error: Error): void;
  /** Clear requests from a replaced transport before retrying initialization. */
  clearPending(): void;
}

export type AcpTransportCloseReason =
  | "process-exit"
  | "remote-close"
  | "transport-error"
  | "requested"
  | "replaced";

export interface AcpTransportSession {
  /** Opaque lifecycle identifier, suitable for correlating cleanup events. */
  readonly id: string;
  /** Whether the session is backed by a local process or a remote wire. */
  readonly kind: "local" | "remote";
}

export interface AcpTransportClosedEvent {
  session: AcpTransportSession;
  reason: AcpTransportCloseReason;
  error: AcpError;
}

/**
 * Lifecycle contract implemented by local process and future wire transports.
 *
 * The lifecycle owns connection resources and delivers parsed JSON-RPC
 * messages to the RPC client. It does not know about AcpBackend, mesh
 * routing, or session state.
 */
export interface AcpTransportLifecycle {
  readonly transport: RpcTransport;
  connect(
    config: BackendConnectionConfig,
    signal: AbortSignal | undefined,
    requester: RpcRequester & RpcPendingController,
  ): Promise<unknown>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getDirectory(): string;
  getProvider(): AgentProvider | null;
  getConnectionInfo(): ConnectionInfo | null;
  getSession(): AcpTransportSession | null;
  setMessageHandler(handler: (message: JsonRpcMessage) => void): void;
  setTransportClosedHandler(handler: (event: AcpTransportClosedEvent) => void): void;
}

export type AcpTransportLifecycleFactory = () => AcpTransportLifecycle;

/**
 * Emission surface used by the event translator to deliver normalized events
 * to session subscribers. Implemented by the session state store.
 */
export interface SessionEventSink {
  emitSessionEvent(sessionId: string, event: AgentEvent): void;
}

/**
 * Typed outcome of invoking an optional ACP method. Only a protocol
 * `acp_method_not_found` maps to `method-not-found`; every other failure
 * (timeout, cancellation, session-not-found, process, auth, ...) propagates
 * as a thrown typed error and never as a capability-absence signal.
 */
export type OptionalMethodOutcome<T> =
  | { kind: "supported"; value: T }
  | { kind: "method-not-found" };

/**
 * Callback used during variant discovery to change a temporary session's model.
 * Provided by the session service; consumed by the capability service.
 */
export type ConfigOptionSetter = (
  sessionId: string,
  configId: string,
  value: string,
) => Promise<import("../types").ConfigOption[]>;
