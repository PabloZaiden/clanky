import type { ServerWebSocket } from "bun";
import { isDomainError } from "../../core/domain-error";
import { SshTerminalBridge } from "../../core/ssh-terminal-bridge";
import { createLogger } from "@pablozaiden/webapp/server";
import { runWithCurrentUser } from "../../core/user-context";
import type { WebSocketData } from "./types";
import { createWorkspaceTerminalConnection } from "../../core/workspace-terminal-connection";
import {
  claimWorkspaceTerminalAttachment,
  type WorkspaceTerminalAttachmentHandle,
} from "../../core/workspace-terminal-attachment-registry";

const log = createLogger("api:websocket");
const SAFE_TERMINAL_ERROR_MESSAGE = "SSH terminal connection failed";
const SAFE_WORKSPACE_TERMINAL_ERROR_MESSAGE = "Terminal connection failed";
const KNOWN_TERMINAL_DOMAIN_ERROR_CODES = new Set([
  "invalid_credential_token",
  "ssh_server_not_found",
  "ssh_server_session_not_found",
  "ssh_session_not_found",
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

const activeWorkspaceTerminalSockets = new Map<string, ServerWebSocket<WebSocketData>>();

function claimWorkspaceTerminalSocket(
  terminalSessionId: string,
  ws: ServerWebSocket<WebSocketData>,
): void {
  const previous = activeWorkspaceTerminalSockets.get(terminalSessionId);
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
  activeWorkspaceTerminalSockets.set(terminalSessionId, ws);
}

function isWorkspaceTerminalSocketActive(
  terminalSessionId: string,
  ws: ServerWebSocket<WebSocketData>,
): boolean {
  return activeWorkspaceTerminalSockets.get(terminalSessionId) === ws;
}

export function releaseWorkspaceTerminalSocket(
  terminalSessionId: string,
  ws: ServerWebSocket<WebSocketData>,
): void {
  if (activeWorkspaceTerminalSockets.get(terminalSessionId) === ws) {
    activeWorkspaceTerminalSockets.delete(terminalSessionId);
  }
}

export interface TerminalErrorPayload {
  code?: string;
  message: string;
}

export async function startWorkspaceTerminalBridge(
  ws: ServerWebSocket<WebSocketData>,
): Promise<void> {
  const terminalSessionId = ws.data.workspaceTerminalSessionId;
  if (!terminalSessionId || ws.data.terminalBridge) {
    return;
  }
  if (!ws.data.user) {
    sendTerminalAuthError(ws, "Authenticated user context is required for terminal connections");
    return;
  }

  claimWorkspaceTerminalSocket(terminalSessionId, ws);
  try {
    const { connection, attachment, resolved } = await runWithCurrentUser(
      ws.data.user,
      async () => await createWorkspaceTerminalConnection(terminalSessionId, {
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
          const payload = getTerminalErrorPayload(error);
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
      }),
    );
    if (!isWorkspaceTerminalSocketActive(terminalSessionId, ws)) {
      await connection.dispose();
      attachment.release();
      return;
    }
    ws.data.terminalBridge = connection;
    ws.data.workspaceTerminalAttachment = attachment;
    const result = await runWithCurrentUser(ws.data.user, async () => await connection.connect());
    if (!isWorkspaceTerminalSocketActive(terminalSessionId, ws)) {
      await connection.dispose();
      attachment.release();
      ws.data.terminalBridge = undefined;
      return;
    }
    ws.data.workspaceTerminalTransport = resolved.transport;
    ws.send(JSON.stringify({
      type: "terminal.connected",
      terminalSessionId,
      transport: resolved.transport,
      runtimeConnectionMode: result.runtimeConnectionMode,
      notice: result.notice ?? null,
    }));
  } catch (error) {
    const payload = getTerminalErrorPayload(error);
    log.error("Failed to connect workspace terminal", {
      terminalSessionId,
      transport: ws.data.workspaceTerminalTransport ?? "unresolved",
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
    ws.data.workspaceTerminalAttachment?.release();
    ws.data.workspaceTerminalAttachment = undefined;
    releaseWorkspaceTerminalSocket(terminalSessionId, ws);
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

  if (sshSessionId) {
    claimWorkspaceTerminalSocket(sshSessionId, ws);
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
      const payload = getTerminalErrorPayload(error, SAFE_WORKSPACE_TERMINAL_ERROR_MESSAGE);
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
  let attachment: WorkspaceTerminalAttachmentHandle | undefined;

  try {
    if (sshSessionId) {
      attachment = await claimWorkspaceTerminalAttachment(sshSessionId, bridge);
      ws.data.workspaceTerminalAttachment = attachment;
    }
    await runWithCurrentUser(ws.data.user, () => bridge.connect());
    if (sshSessionId && !isWorkspaceTerminalSocketActive(sshSessionId, ws)) {
      await bridge.dispose();
      attachment?.release();
      ws.data.workspaceTerminalAttachment = undefined;
      if (ws.data.terminalBridge === bridge) {
        ws.data.terminalBridge = undefined;
      }
      return;
    }
    ws.send(JSON.stringify({
      type: "terminal.connected",
      sshSessionId: sshSessionId ?? null,
      sshServerSessionId: sshServerSessionId ?? null,
    }));
  } catch (error) {
    const payload = getTerminalErrorPayload(error, SAFE_WORKSPACE_TERMINAL_ERROR_MESSAGE);
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
    attachment?.release();
    ws.data.workspaceTerminalAttachment = undefined;
    if (sshSessionId) {
      releaseWorkspaceTerminalSocket(sshSessionId, ws);
    }
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
