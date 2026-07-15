/**
 * Internal types and constants for the ACP backend.
 */

import type { AgentEvent } from "../types";

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
