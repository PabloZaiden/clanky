import type { ServerWebSocket } from "bun";
import { createLogger } from "../../core/logger";
import type { WebSocketData } from "./types";
import type { startTerminalBridge, sendTerminalAuthError } from "./terminal";

const log = createLogger("api:websocket");

type TerminalHelpers = {
  startTerminalBridge: typeof startTerminalBridge;
  sendTerminalAuthError: typeof sendTerminalAuthError;
};

function getProxyMessagePayload(msg: string | Buffer): string | Uint8Array<ArrayBuffer> {
  if (typeof msg === "string") {
    return msg;
  }

  const payload = new Uint8Array(new ArrayBuffer(msg.length));
  payload.set(msg);
  return payload;
}

/**
 * Creates the WebSocket message handler bound to the given terminal helpers.
 * Accepting helpers by reference (not closure) allows tests to spy on the
 * handler object's methods and have the spy intercepted correctly.
 */
export function createMessageHandler(helpers: TerminalHelpers) {
  return function message(ws: ServerWebSocket<WebSocketData>, msg: string | Buffer): void {
    if (ws.data.portForwardMode) {
      const proxySocket = ws.data.proxySocket;

      if (proxySocket?.readyState === WebSocket.OPEN) {
        proxySocket.send(getProxyMessagePayload(msg));
        return;
      }

      if (ws.data.vncMode) {
        if (ws.data.vncSocket && !ws.data.vncSocket.destroyed) {
          ws.data.vncSocket.write(typeof msg === "string" ? Buffer.from(msg) : msg);
          return;
        }
        log.warn("Closing VNC WebSocket because TCP bridge is not open", {
          vncSessionId: ws.data.vncSessionId,
        });
        ws.close(1011, "VNC TCP bridge is not open");
        return;
      }

      // Treat CONNECTING as transient — the upstream may open shortly.
      // Drop the message silently instead of closing the client, to avoid
      // flaky disconnects during the handshake/startup window.
      if (proxySocket?.readyState === WebSocket.CONNECTING) {
        log.debug("Dropping port-forward message while upstream proxy is still connecting", {
          portForwardId: ws.data.portForwardId,
        });
        return;
      }

      // Upstream is definitively unavailable (CLOSING, CLOSED, or missing) — close the client.
      log.warn("Closing port-forward WebSocket because upstream proxy is not open", {
        portForwardId: ws.data.portForwardId,
        proxyReadyState: proxySocket ? proxySocket.readyState : "missing",
      });
      try {
        ws.close(1011, "Upstream proxy is not open");
      } catch (closeError) {
        log.debug("Error while closing WebSocket after upstream proxy failure", {
          error: String(closeError),
        });
      }
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
          void ws.data.terminalBridge.resize(data.cols, data.rows).catch((resizeError: Error) => {
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
