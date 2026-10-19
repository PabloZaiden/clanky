/**
 * Live preview domain and bridge protocol types.
 */

import type { ExecutionHostBinding } from "./execution-host";

export type PreviewSessionStatus = "active" | "closing" | "closed" | "failed";

export function previewWebSocketCloseCode(code: number | undefined): number {
  if (code === undefined) return 1000;
  return Number.isInteger(code)
    && ((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999))
    ? code
    : 1011;
}

export type PreviewTargetKind = "workspace" | "server";

export type PreviewTarget =
  | { kind: "workspace"; reference: string }
  | { kind: "server"; reference: string };

export interface CodePreviewOptions {
  chat?: string;
  task?: string;
  acceptServerLicenseTerms: boolean;
}

export type CodePreviewCleanup =
  | { kind: "owned"; temporaryDirectory: string; directory: string; pathStyle: "posix" | "windows" }
  | { kind: "invalid" };

export interface PreviewSessionConfig {
  id: string;
  targetKind: PreviewTargetKind;
  workspaceId?: string;
  executionHostBinding: ExecutionHostBinding;
  remoteHost: string;
  remotePort: number;
  localHost: string;
  localPort: number;
  localUrl: string;
  initialPath: string;
  cliClientId?: string;
  cliHostname?: string;
  codeCleanup?: CodePreviewCleanup;
  createdAt: string;
  updatedAt: string;
}

export interface PreviewSessionState {
  status: PreviewSessionStatus;
  connectedAt?: string;
  closedAt?: string;
  error?: string;
}

export interface PreviewSession {
  config: PreviewSessionConfig;
  state: PreviewSessionState;
}

export interface PreviewUpstreamOptions {
  protocol?: "http" | "https";
}

export interface RegisterCliPreviewOptions extends PreviewUpstreamOptions {
  code?: CodePreviewOptions;
  target: PreviewTarget;
  remoteHost: string;
  remotePort: number;
  localHost: string;
  localPort: number;
  localUrl: string;
  initialPath: string;
  cliClientId?: string;
  cliHostname?: string;
}

interface PreviewEventTarget {
  workspaceId?: string;
  executionHostBinding?: ExecutionHostBinding;
}

export type PreviewEvent =
  | ({ type: "preview.created"; previewId: string; preview: PreviewSession } & PreviewEventTarget & { timestamp: string })
  | ({ type: "preview.connected"; previewId: string; preview: PreviewSession } & PreviewEventTarget & { timestamp: string })
  | ({ type: "preview.closed"; previewId: string; preview: PreviewSession } & PreviewEventTarget & { timestamp: string })
  | ({ type: "preview.failed"; previewId: string; error: string; preview?: PreviewSession } & PreviewEventTarget & { timestamp: string });

export interface PreviewBridgeHelloMessage extends PreviewUpstreamOptions {
  type: "hello";
  code?: CodePreviewOptions;
  target: PreviewTarget;
  remoteHost: string;
  remotePort: number;
  localHost: string;
  localPort: number;
  localUrl: string;
  initialPath: string;
  cliClientId?: string;
  cliHostname?: string;
}

export interface PreviewBridgeReadyMessage {
  type: "ready";
  previewId: string;
  targetKind: PreviewTargetKind;
  workspaceId?: string;
  code?: { directory: string; remotePort: number };
}

export interface PreviewBridgeRequestStartMessage {
  type: "request.start";
  streamId: string;
  method: string;
  path: string;
  headers: Array<[string, string]>;
  body?: string;
  responseFlowControl?: boolean;
}

export const PREVIEW_RESPONSE_WINDOW_BYTES = 256 * 1024;
export const PREVIEW_RESPONSE_CHUNK_BYTES = 64 * 1024;

export interface PreviewBridgeResponseStartMessage {
  type: "response.start";
  streamId: string;
  status: number;
  headers: Array<[string, string]>;
}

export interface PreviewBridgeBodyMessage {
  type: "request.body" | "response.body";
  streamId: string;
  body: string;
}

export interface PreviewBridgeEndMessage {
  type: "request.end" | "response.end";
  streamId: string;
}

export interface PreviewBridgeErrorMessage {
  type: "stream.error";
  streamId?: string;
  error: string;
  code?: string;
}

export interface PreviewBridgeWebSocketOpenMessage {
  type: "websocket.open";
  streamId: string;
  path: string;
  headers: Array<[string, string]>;
}

export type PreviewBridgePath = string & {
  readonly __previewBridgePath: unique symbol;
};

const PREVIEW_BRIDGE_PATH_BASE_URL = "http://clanky-preview.invalid/";

/**
 * Accept only bridge-relative request paths. Destination origin validation is
 * performed separately against the registered preview runtime.
 */
export function parsePreviewBridgePath(value: unknown): PreviewBridgePath | null {
  if (
    typeof value !== "string"
    || !value.startsWith("/")
    || value.startsWith("//")
    || value.includes("\\")
    || [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  ) {
    return null;
  }

  try {
    const parsed = new URL(value, PREVIEW_BRIDGE_PATH_BASE_URL);
    if (
      parsed.origin !== new URL(PREVIEW_BRIDGE_PATH_BASE_URL).origin
      || parsed.username
      || parsed.password
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return value as PreviewBridgePath;
}

export interface PreviewBridgeWebSocketMessage {
  type: "websocket.message";
  streamId: string;
  body: string;
  binary: boolean;
}

export interface PreviewBridgeWebSocketCloseMessage {
  type: "websocket.close";
  streamId: string;
  code?: number;
  reason?: string;
}

export type PreviewBridgeClientMessage =
  | PreviewBridgeHelloMessage
  | PreviewBridgeRequestStartMessage
  | PreviewBridgeBodyMessage
  | PreviewBridgeEndMessage
  | PreviewBridgeWebSocketOpenMessage
  | PreviewBridgeWebSocketMessage
  | PreviewBridgeWebSocketCloseMessage
  | { type: "close" }
  | { type: "request.cancel"; streamId: string }
  | { type: "response.ack"; streamId: string; bytes: number }
  | { type: "bridge.pong" };

export type PreviewBridgeServerMessage =
  | PreviewBridgeReadyMessage
  | PreviewBridgeResponseStartMessage
  | PreviewBridgeBodyMessage
  | PreviewBridgeEndMessage
  | PreviewBridgeErrorMessage
  | PreviewBridgeWebSocketMessage
  | PreviewBridgeWebSocketCloseMessage
  | { type: "bridge.ping" };
