/**
 * Live preview domain and bridge protocol types.
 */

import type { ExecutionHostBinding } from "./execution-host";

export type PreviewSessionStatus = "active" | "closing" | "closed" | "failed";

export type PreviewTargetKind = "workspace" | "server";

export type PreviewTarget =
  | { kind: "workspace"; reference: string }
  | { kind: "server"; reference: string };

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

export interface RegisterCliPreviewOptions {
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

export interface PreviewBridgeHelloMessage {
  type: "hello";
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
}

export interface PreviewBridgeRequestStartMessage {
  type: "request.start";
  streamId: string;
  method: string;
  path: string;
  headers: Array<[string, string]>;
  body?: string;
}

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
}

export interface PreviewBridgeWebSocketOpenMessage {
  type: "websocket.open";
  streamId: string;
  path: string;
  headers: Array<[string, string]>;
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
