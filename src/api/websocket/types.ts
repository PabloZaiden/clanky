import type { SshTerminalBridge } from "../../core/ssh-terminal-bridge";

/**
 * WebSocket client data attached to each connection.
 * Stored in the WebSocket's data property for per-connection state.
 */
export interface WebSocketData {
  /** Optional loop ID to filter events - only events for this loop are sent */
  loopId?: string;
  /** Optional chat ID to filter chat events */
  chatId?: string;
  /** Optional SSH session ID to filter session events or attach a terminal */
  sshSessionId?: string;
  /** Optional standalone SSH server session ID to filter session events or attach a terminal */
  sshServerSessionId?: string;
  /** Optional provisioning job ID to filter provisioning events */
  provisioningJobId?: string;
  /** Whether sensitive provisioning data should be included */
  sensitive?: boolean;
  /** Optional forwarded port ID for proxied websocket traffic */
  portForwardId?: string;
  /** Whether this socket is a terminal transport socket */
  terminalMode?: boolean;
  /** Whether this socket proxies a forwarded port websocket */
  portForwardMode?: boolean;
  /** Active terminal bridge for terminal-mode sockets */
  terminalBridge?: SshTerminalBridge;
  /** Outbound websocket for proxied forwarded-port traffic */
  proxySocket?: WebSocket;
  /** Target URL for proxied forwarded-port traffic */
  proxyTargetUrl?: string;
  /** Unsubscribe functions for event emitter cleanup */
  unsubscribers?: Array<() => void>;
}
