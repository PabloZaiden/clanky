import type { SshTerminalBridge } from "../../core/ssh-terminal-bridge";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";

/**
 * WebSocket client data attached to each connection.
 * Stored in the WebSocket's data property for per-connection state.
 */
export interface WebSocketData {
  /** Optional SSH session ID to attach a terminal */
  sshSessionId?: string;
  /** Optional standalone SSH server session ID to attach a terminal */
  sshServerSessionId?: string;
  /** Optional VNC session ID for raw RFB websocket traffic */
  vncSessionId?: string;
  /** Whether this socket is a terminal transport socket */
  terminalMode?: boolean;
  /** Whether this socket bridges noVNC RFB traffic to a local TCP tunnel */
  vncMode?: boolean;
  /** Whether this socket is the CLI live-preview bridge */
  previewBridgeMode?: boolean;
  /** Registered preview session for a CLI bridge socket */
  previewBridgeSessionId?: string;
  /** Keepalive timer for CLI live-preview bridge sockets */
  previewBridgeKeepalive?: ReturnType<typeof setInterval>;
  /** Authenticated framework user for websocket operations that need persistence ownership */
  user?: CurrentUser;
  /** Active TCP socket for VNC bridge traffic */
  vncSocket?: import("node:net").Socket;
  /** RFB payloads received before the VNC TCP socket is ready */
  pendingVncMessages?: Buffer[];
  /** Active terminal bridge for terminal-mode sockets */
  terminalBridge?: SshTerminalBridge;
}
