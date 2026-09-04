import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import type { InteractiveTerminalConnection } from "../../core/terminal";
import type { WorkspaceTerminalTransport } from "../../core/workspace-terminal-connection";
import type { WorkspaceTerminalAttachmentHandle } from "../../core/workspace-terminal-attachment-registry";
import type { TcpTunnel } from "../../core/tcp-tunnel";

/**
 * WebSocket client data attached to each connection.
 * Stored in the WebSocket's data property for per-connection state.
 */
export interface WebSocketData {
  /** Optional standalone SSH server session ID to attach a terminal */
  sshServerSessionId?: string;
  /** Canonical workspace terminal session ID */
  workspaceTerminalSessionId?: string;
  /** Resolved transport for a canonical workspace terminal */
  workspaceTerminalTransport?: WorkspaceTerminalTransport;
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
  vncSocket?: TcpTunnel;
  /** RFB payloads received before the VNC TCP socket is ready */
  pendingVncMessages?: Buffer[];
  /** Active terminal bridge for terminal-mode sockets */
  terminalBridge?: Pick<InteractiveTerminalConnection, "sendInput" | "resize" | "dispose">;
  /** Core-owned attachment for canonical workspace terminal sessions */
  workspaceTerminalAttachment?: WorkspaceTerminalAttachmentHandle;
  /** Whether this socket relays a mesh ACP session */
  meshAcpMode?: boolean;
  /** Mesh ACP session identifier */
  meshAcpSessionId?: string;
  /** Mesh ACP session bearer token */
  meshAcpSessionToken?: string;
  /** Whether this socket relays a Mesh terminal session on the execution peer */
  meshTerminalMode?: boolean;
  /** Mesh terminal session identifier */
  meshTerminalSessionId?: string;
  /** Mesh terminal session bearer token */
  meshTerminalSessionToken?: string;
  /** Whether this socket relays a Mesh TCP tunnel on the execution peer */
  meshTcpTunnelMode?: boolean;
  meshTcpTunnelSessionId?: string;
  meshTcpTunnelSessionToken?: string;
}
