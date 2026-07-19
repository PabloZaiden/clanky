import type { ServerWebSocket } from "bun";
import { isDomainError } from "../../core/domain-error";
import { SshTerminalBridge } from "../../core/ssh-terminal-bridge";
import { createLogger } from "@pablozaiden/webapp/server";
import { runWithCurrentUser } from "../../core/user-context";
import type { WebSocketData } from "./types";

const log = createLogger("api:websocket");
const SAFE_TERMINAL_ERROR_MESSAGE = "SSH terminal connection failed";
const KNOWN_TERMINAL_DOMAIN_ERROR_CODES = new Set([
  "invalid_credential_token",
  "ssh_server_not_found",
  "ssh_server_session_not_found",
  "ssh_session_not_found",
  "workspace_not_found",
]);

export interface TerminalErrorPayload {
  code?: string;
  message: string;
}

export function getTerminalErrorPayload(error: unknown): TerminalErrorPayload {
  if (isDomainError(error) && KNOWN_TERMINAL_DOMAIN_ERROR_CODES.has(error.code)) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  return { message: SAFE_TERMINAL_ERROR_MESSAGE };
}

export async function startTerminalBridge(
  ws: ServerWebSocket<WebSocketData>,
  credentialToken?: string,
): Promise<void> {
  const { sshSessionId, sshServerSessionId } = ws.data;
  const terminalSessionId = sshSessionId ?? sshServerSessionId;
  if (!terminalSessionId || ws.data.terminalBridge) {
    return;
  }
  if (!ws.data.user) {
    sendTerminalAuthError(ws, "Authenticated user context is required for SSH terminal connections");
    return;
  }

  const bridge = new SshTerminalBridge(terminalSessionId, {
    onOutput: (chunk) => {
      try {
        ws.send(JSON.stringify({ type: "terminal.output", data: chunk }));
      } catch (sendError) {
        log.trace("Failed to send terminal output", { error: String(sendError), sshSessionId });
      }
    },
    onClipboardCopy: (text) => {
      try {
        ws.send(JSON.stringify({ type: "terminal.clipboard", text }));
      } catch (sendError) {
        log.trace("Failed to send terminal clipboard event", { error: String(sendError), sshSessionId });
      }
    },
    onError: (error) => {
      const payload = getTerminalErrorPayload(error);
      try {
        ws.send(JSON.stringify({
          type: "terminal.error",
          ...payload,
        }));
      } catch (sendError) {
        log.trace("Failed to send terminal error", { error: String(sendError), sshSessionId });
      }
    },
    onExit: (code, signal) => {
      try {
        ws.send(JSON.stringify({
          type: "terminal.closed",
          code,
          signal,
        }));
      } catch (sendError) {
        log.trace("Failed to send terminal close event", { error: String(sendError), sshSessionId });
      }
    },
  }, sshServerSessionId
    ? {
        sessionKind: "standalone",
        credentialToken,
      }
    : undefined);
  ws.data.terminalBridge = bridge;

  try {
    await runWithCurrentUser(ws.data.user, () => bridge.connect());
    ws.send(JSON.stringify({
      type: "terminal.connected",
      sshSessionId: sshSessionId ?? null,
      sshServerSessionId: sshServerSessionId ?? null,
    }));
  } catch (error) {
    const payload = getTerminalErrorPayload(error);
    log.error("Failed to connect SSH terminal bridge", {
      terminalSessionId,
      sshSessionId,
      sshServerSessionId,
      error: String(error),
    });
    try {
      ws.send(JSON.stringify({
        type: "terminal.error",
        ...payload,
      }));
    } catch (sendError) {
      log.trace("Failed to send terminal startup error", {
        error: String(sendError),
        sshSessionId: terminalSessionId,
      });
    }
    await bridge.dispose();
    if (ws.data.terminalBridge === bridge) {
      ws.data.terminalBridge = undefined;
    }
  }
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
