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

import type { AgentEvent } from "../types";
import type { JsonRpcMessage } from "./types";

/**
 * Raw wire transport used by the RPC client to write outbound JSON-RPC
 * messages. Implemented by the transport/lifecycle service, which owns the
 * subprocess and stdin.
 */
export interface RpcTransport {
  /** Write one JSON-RPC message to the process stdin. Throws when unwritable. */
  write(message: JsonRpcMessage): void;
  /** Whether the transport currently has a writable stdin. */
  isWritable(): boolean;
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
