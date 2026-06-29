import type { SshTerminalBridge } from "../../core/ssh-terminal-bridge";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";

/**
 * WebSocket client data attached to each connection.
 * Stored in the WebSocket's data property for per-connection state.
 */
export interface WebSocketData {
  /** Optional task ID to filter events - only events for this task are sent */
  taskId?: string;
  /** Optional chat ID to filter chat events */
  chatId?: string;
  /** Optional agent ID to filter scheduled agent events */
  agentId?: string;
  /** Optional agent run ID to filter scheduled agent run events */
  agentRunId?: string;
  /** Optional SSH session ID to filter session events or attach a terminal */
  sshSessionId?: string;
  /** Optional standalone SSH server session ID to filter session events or attach a terminal */
  sshServerSessionId?: string;
  /** Optional provisioning job ID to filter provisioning events */
  provisioningJobId?: string;
  /** Whether sensitive provisioning data should be included */
  sensitive?: boolean;
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
  /** Unsubscribe functions for event emitter cleanup */
  unsubscribers?: Array<() => void>;
}
