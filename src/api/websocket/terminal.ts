import type { ServerWebSocket } from "bun";
import { isDomainError } from "../../core/domain-error";
import { createLogger } from "@pablozaiden/webapp/server";
import { runWithCurrentUser } from "../../core/user-context";
import type { WebSocketData } from "./types";
import {
  createTerminalConnection,
  resolveTerminal,
} from "../../core/terminal-connection";

const log = createLogger("api:websocket");
const SAFE_TERMINAL_ERROR_MESSAGE = "SSH terminal connection failed";
const SAFE_TERMINAL_CONNECTION_ERROR_MESSAGE = "Terminal connection failed";
const KNOWN_TERMINAL_DOMAIN_ERROR_CODES = new Set([
  "invalid_credential_token",
  "ssh_server_not_found",
  "workspace_not_found",
  "terminal_session_not_found",
  "terminal_session_closing",
  "terminal_target_mismatch",
  "terminal_execution_target_changed",
  "terminal_directory_unavailable",
  "terminal_connection_unavailable",
  "terminal_persistent_session_attach_unavailable",
  "mesh_terminal_capability_unavailable",
  "mesh_terminal_capability_mismatch",
  "mesh_terminal_target_unavailable",
  "mesh_terminal_link_unavailable",
  "mesh_terminal_session_expired",
]);

const activeTerminalSockets = new Map<string, ServerWebSocket<WebSocketData>>();

function claimTerminalSocket(
  terminalSessionId: string,
  ws: ServerWebSocket<WebSocketData>,
): void {
  const previous = activeTerminalSockets.get(terminalSessionId);
  if (previous && previous !== ws) {
    try {
      previous.close(1000, "Terminal reattached");
    } catch (error) {
      log.debug("Failed to close the previous workspace terminal attachment", {
        terminalSessionId,
        error: String(error),
      });
    }
  }
  activeTerminalSockets.set(terminalSessionId, ws);
}

function isTerminalSocketActive(
  terminalSessionId: string,
  ws: ServerWebSocket<WebSocketData>,
): boolean {
  return activeTerminalSockets.get(terminalSessionId) === ws;
}

export function releaseTerminalSocket(
  terminalSessionId: string,
  ws: ServerWebSocket<WebSocketData>,
): void {
  if (activeTerminalSockets.get(terminalSessionId) === ws) {
    activeTerminalSockets.delete(terminalSessionId);
  }
}

export interface TerminalErrorPayload {
  code?: string;
  message: string;
}

export async function startTerminalBridge(
  ws: ServerWebSocket<WebSocketData>,
  credentialToken?: string,
): Promise<void> {
  const terminalSessionId = ws.data.terminalSessionId;
  if (!terminalSessionId || ws.data.terminalBridge) {
    return;
  }
  if (!ws.data.user) {
    sendTerminalAuthError(ws, "Authenticated user context is required for terminal connections");
    return;
  }

  try {
    if (!credentialToken) {
      const resolved = await runWithCurrentUser(
        ws.data.user,
        async () => await resolveTerminal(terminalSessionId),
      );
      if (resolved.executionHostBinding.host.kind === "ssh" && !resolved.workspace) {
        return;
      }
    }

    claimTerminalSocket(terminalSessionId, ws);
    const { connection, attachment, resolved } = await runWithCurrentUser(
      ws.data.user,
      async () => await createTerminalConnection(terminalSessionId, {
        onOutput: (chunk) => {
          try {
            ws.send(JSON.stringify({ type: "terminal.output", data: chunk }));
          } catch (sendError) {
            log.trace("Failed to send terminal output", {
              error: String(sendError),
              terminalSessionId,
            });
          }
        },
        onClipboardCopy: (text) => {
          try {
            ws.send(JSON.stringify({ type: "terminal.clipboard", text }));
          } catch (sendError) {
            log.trace("Failed to send terminal clipboard event", {
              error: String(sendError),
              terminalSessionId,
            });
          }
        },
        onError: (error) => {
          const payload = getTerminalErrorPayload(error, SAFE_TERMINAL_CONNECTION_ERROR_MESSAGE);
          try {
            ws.send(JSON.stringify({ type: "terminal.error", ...payload }));
          } catch (sendError) {
            log.trace("Failed to send terminal error", {
              error: String(sendError),
              terminalSessionId,
            });
          }
        },
        onExit: (code, signal) => {
          try {
            ws.send(JSON.stringify({ type: "terminal.closed", code, signal }));
          } catch (sendError) {
            log.trace("Failed to send terminal close event", {
              error: String(sendError),
              terminalSessionId,
            });
          }
        },
      }, credentialToken),
    );
    if (!isTerminalSocketActive(terminalSessionId, ws)) {
      await connection.dispose();
      attachment.release();
      return;
    }
    ws.data.terminalBridge = connection;
    ws.data.terminalAttachment = attachment;
    const result = await runWithCurrentUser(ws.data.user, async () => await connection.connect());
    if (!isTerminalSocketActive(terminalSessionId, ws)) {
      await connection.dispose();
      attachment.release();
      ws.data.terminalBridge = undefined;
      return;
    }
    const transport = resolved.executionHostBinding.host.kind;
    ws.data.terminalTransport = transport;
    ws.send(JSON.stringify({
      type: "terminal.connected",
      terminalSessionId,
      transport,
      runtimeConnectionMode: result.runtimeConnectionMode,
      notice: result.notice ?? null,
    }));
  } catch (error) {
    const payload = getTerminalErrorPayload(error);
    log.error("Failed to connect workspace terminal", {
      terminalSessionId,
      transport: ws.data.terminalTransport ?? "unresolved",
      error: String(error),
    });
    try {
      ws.send(JSON.stringify({ type: "terminal.error", ...payload }));
    } catch (sendError) {
      log.trace("Failed to send terminal startup error", {
        error: String(sendError),
        terminalSessionId,
      });
    }
    const bridge = ws.data.terminalBridge;
    ws.data.terminalBridge = undefined;
    ws.data.terminalAttachment?.release();
    ws.data.terminalAttachment = undefined;
    releaseTerminalSocket(terminalSessionId, ws);
    await bridge?.dispose();
  }
}

export function getTerminalErrorPayload(
  error: unknown,
  fallbackMessage = SAFE_TERMINAL_ERROR_MESSAGE,
): TerminalErrorPayload {
  if (isDomainError(error) && KNOWN_TERMINAL_DOMAIN_ERROR_CODES.has(error.code)) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  return { message: fallbackMessage };
}

export function sendTerminalAuthError(
  ws: ServerWebSocket<WebSocketData>,
  message: string,
): void {
  try {
    ws.send(JSON.stringify({ type: "terminal.error", message }));
  } catch (sendError) {
    log.trace("Failed to send terminal auth error", { error: String(sendError) });
  }

  try {
    ws.close(1008, message);
  } catch (closeError) {
    log.trace("Failed to close terminal websocket after auth error", {
      error: String(closeError),
    });
  }
}
