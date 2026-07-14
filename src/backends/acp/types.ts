/**
 * Internal types and constants for the ACP backend.
 */

import type { AgentEvent } from "../types";

// Compatibility types retained for translation/unit tests.
export type AcpSession = {
  id: string;
  title?: string;
  time: { created: number };
};

export type AcpEvent = {
  type: string;
  properties: any;
};

export type Part = any;
export type AssistantMessage = any;

/**
 * Context object for translateEvent(), bundling per-subscription tracking state.
 */
export interface TranslateEventContext {
  /** The session ID to filter events for */
  sessionId: string;
  /** Subscription ID for logging */
  subId: string;
  /** Set of message IDs we've already emitted start events for */
  emittedMessageStarts: Set<string>;
  /** Map of tool part IDs to their last emitted status */
  toolPartStatus: Map<string, string>;
  /** Map of reasoning part IDs to their last known text length */
  reasoningTextLength: Map<string, number>;
  /** Per-subscription fallback reasoning deltas pending duplicate suppression */
  pendingReasoningFallbackDeltas: Map<string, string>;
  /** Map of part IDs to their type (text, reasoning, tool, etc.) for delta routing */
  partTypes: Map<string, string>;
  /** Client-like object used for session debug queries during event translation */
  client: any;
  /** Directory for session queries */
  directory: string;
}

export type JsonRpcId = number | string;

export type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

export type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type SessionSubscriber = (event: AgentEvent) => void;

export type PermissionOption = {
  optionId: string;
  kind?: string;
};

export type PendingPermissionRequest = {
  sessionId: string;
  rpcId: JsonRpcId;
  options: PermissionOption[];
};

export const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
export const PROMPT_REQUEST_TIMEOUT_MS = 1_800_000;
export const MAX_RECENT_PROCESS_LINES = 20;
export const SSHPASS_INVALID_PASSWORD_EXIT_CODE = 5;
