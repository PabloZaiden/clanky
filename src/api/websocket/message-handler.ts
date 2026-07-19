import type { ServerWebSocket } from "bun";
import { createLogger } from "@pablozaiden/webapp/server";
import { runWithCurrentUser } from "../../core/user-context";
import type { WebSocketData } from "./types";
import type { startTerminalBridge, sendTerminalAuthError } from "./terminal";
import { previewSessionManager } from "../../core/preview-session-manager";

const log = createLogger("api:websocket");

type TerminalHelpers = {
  startTerminalBridge: typeof startTerminalBridge;
  sendTerminalAuthError: typeof sendTerminalAuthError;
};

/**
 * Creates the WebSocket message handler bound to the given terminal helpers.
 * Accepting helpers by reference (not closure) allows tests to spy on the
 * handler object's methods and have the spy intercepted correctly.
 */
export function createMessageHandler(helpers: TerminalHelpers) {
  return function message(ws: ServerWebSocket<WebSocketData>, msg: string | Buffer): void {
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
          void helpers.startTerminalBridge(ws, credentialToken);
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
              "Authenticated user context is required for SSH terminal resize",
            );
            return;
          }
          const resize = () => ws.data.terminalBridge!.resize(data.cols, data.rows);
          const resizePromise = runWithCurrentUser(ws.data.user, resize);
          void resizePromise.catch((resizeError: Error) => {
            log.warn("Ignoring SSH terminal resize error", {
              sshSessionId: ws.data.sshSessionId,
              sshServerSessionId: ws.data.sshServerSessionId,
              error: String(resizeError),
            });
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
