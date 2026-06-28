/**
 * Workspace live preview domain types.
 */

export type PreviewSessionStatus = "active" | "closing" | "closed" | "failed";

export interface PreviewSessionConfig {
  id: string;
  workspaceId: string;
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
  workspace: string;
  remoteHost: string;
  remotePort: number;
  localHost: string;
  localPort: number;
  localUrl: string;
  initialPath: string;
  cliClientId?: string;
  cliHostname?: string;
}

export type PreviewEvent =
  | { type: "preview.created"; previewId: string; workspaceId: string; preview: PreviewSession; timestamp: string }
  | { type: "preview.connected"; previewId: string; workspaceId: string; preview: PreviewSession; timestamp: string }
  | { type: "preview.closed"; previewId: string; workspaceId: string; preview: PreviewSession; timestamp: string }
  | { type: "preview.failed"; previewId: string; workspaceId: string; error: string; preview?: PreviewSession; timestamp: string };

export interface PreviewBridgeHelloMessage {
  type: "hello";
  workspace: string;
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
  workspaceId: string;
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
