import type { ServerWebSocket } from "bun";
import { createLogger } from "@pablozaiden/webapp/server";
import { runWithCurrentUser } from "../../core/user-context";
import type { WebSocketData } from "./types";
import type { startSshServerTerminalBridge, sendTerminalAuthError } from "./terminal";
import { previewSessionManager } from "../../core/preview-session-manager";
import { meshAcpGateway } from "../../core/mesh-acp-gateway";
import { meshTerminalGateway } from "../../core/mesh-terminal-gateway";
import { MESH_TERMINAL_MAX_INPUT_BYTES } from "@/shared/mesh-terminal";

const log = createLogger("api:websocket");

type TerminalHelpers = {
  startSshServerTerminalBridge: typeof startSshServerTerminalBridge;
  sendTerminalAuthError: typeof sendTerminalAuthError;
};

interface PendingTerminalResize {
  cols: number;
  rows: number;
}

interface TerminalResizeState {
  pending?: PendingTerminalResize;
  running: boolean;
}

type TerminalResizeStates = WeakMap<
  ServerWebSocket<WebSocketData>,
  TerminalResizeState
>;

function logTerminalResizeError(
  ws: ServerWebSocket<WebSocketData>,
  error: unknown,
): void {
  log.warn("Ignoring terminal resize error", {
    terminalSessionId: ws.data.workspaceTerminalSessionId,
    sshServerSessionId: ws.data.sshServerSessionId,
    error: String(error),
  });
}

async function drainLatestTerminalResize(
  ws: ServerWebSocket<WebSocketData>,
  states: TerminalResizeStates,
  state: TerminalResizeState,
): Promise<void> {
  try {
    while (state.pending) {
      const request = state.pending;
      state.pending = undefined;
      const bridge = ws.data.terminalBridge;
      const user = ws.data.user;
      if (!bridge || !user) {
        return;
      }
      try {
        await runWithCurrentUser(
          user,
          () => bridge.resize(request.cols, request.rows),
        );
      } catch (error) {
        logTerminalResizeError(ws, error);
      }
    }
  } finally {
    state.running = false;
    if (!state.pending) {
      states.delete(ws);
    }
  }
}

function enqueueLatestTerminalResize(
  ws: ServerWebSocket<WebSocketData>,
  states: TerminalResizeStates,
  request: PendingTerminalResize,
): void {
  let state = states.get(ws);
  if (!state) {
    state = { running: false };
    states.set(ws, state);
  }
  state.pending = request;
  if (state.running) {
    return;
  }
  state.running = true;
  void drainLatestTerminalResize(ws, states, state).catch((error: Error) => {
    log.warn("Terminal resize queue failed", {
      terminalSessionId: ws.data.workspaceTerminalSessionId,
      sshServerSessionId: ws.data.sshServerSessionId,
      error: String(error),
    });
  });
}

/**
 * Creates the WebSocket message handler bound to the given terminal helpers.
 * Accepting helpers by reference (not closure) allows tests to spy on the
 * handler object's methods and have the spy intercepted correctly.
 */
export function createMessageHandler(helpers: TerminalHelpers) {
  const resizeStates: TerminalResizeStates = new WeakMap();

  return function message(ws: ServerWebSocket<WebSocketData>, msg: string | Buffer): void {
    if (ws.data.meshAcpMode && ws.data.meshAcpSessionId) {
      void meshAcpGateway.message(ws.data.meshAcpSessionId, msg).catch((error: Error) => {
        log.warn("Mesh ACP relay message failed", {
          sessionId: ws.data.meshAcpSessionId,
          error: String(error),
        });
        ws.close(1003, "Invalid mesh ACP message");
      });
      return;
    }

    if (
      ws.data.meshTerminalMode
      && ws.data.meshTerminalSessionId
      && ws.data.meshTerminalSessionToken
    ) {
      void meshTerminalGateway.message(
        ws.data.meshTerminalSessionId,
        ws.data.meshTerminalSessionToken,
        msg,
        ws,
      ).catch((error: Error) => {
        log.warn("Mesh terminal relay message failed", {
          sessionId: ws.data.meshTerminalSessionId,
          error: String(error),
        });
        ws.close(1003, "Invalid Mesh terminal message");
      });
      return;
    }

    if (ws.data.previewBridgeMode) {
      if (!ws.data.user) {
        ws.close(1008, "Authenticated user context is required for preview bridges");
        return;
      }
      void runWithCurrentUser(ws.data.user, () => previewSessionManager.handleBridgeMessage(ws, msg)).catch((error: Error) => {
        log.warn("Preview bridge message failed", {
          previewId: ws.data.previewBridgeSessionId,
          error: String(error),
        });
        try {
          ws.send(JSON.stringify({ type: "stream.error", error: String(error) }));
        } catch {
          // Ignore send errors while closing a failed preview bridge.
        }
        ws.close(1011, "Preview bridge message handling failed");
      });
      return;
    }

    if (ws.data.vncMode) {
      if (ws.data.vncSocket && !ws.data.vncSocket.destroyed) {
        ws.data.vncSocket.write(typeof msg === "string" ? Buffer.from(msg) : msg);
        return;
      }
      if (!ws.data.vncSocket) {
        ws.data.pendingVncMessages = ws.data.pendingVncMessages ?? [];
        ws.data.pendingVncMessages.push(typeof msg === "string" ? Buffer.from(msg) : msg);
        return;
      }
      log.warn("Closing VNC WebSocket because TCP bridge is not open", {
        vncSessionId: ws.data.vncSessionId,
      });
      ws.close(1011, "VNC TCP bridge is not open");
      return;
    }

    // Parse message if needed for future commands
    try {
      const data = JSON.parse(typeof msg === "string" ? msg : msg.toString());

      if (ws.data.terminalMode && ws.data.sshServerSessionId && !ws.data.terminalBridge) {
        if (data.type === "terminal.auth") {
          const credentialToken = typeof data.credentialToken === "string"
            ? data.credentialToken.trim()
            : "";
          if (!credentialToken) {
            helpers.sendTerminalAuthError(
              ws,
              "credentialToken is required for standalone SSH terminals",
            );
            return;
          }
          void helpers.startSshServerTerminalBridge(ws, credentialToken);
          return;
        }
        if (data.type !== "ping") {
          helpers.sendTerminalAuthError(
            ws,
            "terminal.auth is required before using a standalone SSH terminal",
          );
          return;
        }
      }

      if (ws.data.terminalMode && ws.data.terminalBridge) {
        if (data.type === "terminal.input" && typeof data.data === "string") {
          if (Buffer.byteLength(data.data, "utf8") > MESH_TERMINAL_MAX_INPUT_BYTES) {
            ws.close(1009, "Terminal input is too large");
            return;
          }
          ws.data.terminalBridge.sendInput(data.data);
          return;
        }
        if (
          data.type === "terminal.resize" &&
          typeof data.cols === "number" &&
          typeof data.rows === "number"
        ) {
          if (!ws.data.user) {
            helpers.sendTerminalAuthError(
              ws,
              "Authenticated user context is required for terminal resize",
            );
            return;
          }
          enqueueLatestTerminalResize(ws, resizeStates, {
            cols: data.cols,
            rows: data.rows,
          });
          return;
        }
      }

      // Handle ping/pong for keep-alive
      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch (parseError) {
      log.trace("Received invalid JSON from WebSocket client", { error: String(parseError) });
    }
  };
}
