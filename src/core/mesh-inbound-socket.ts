/**
 * Transport-neutral authorization and attachment for inbound Mesh sockets.
 *
 * Direct Mesh routes and relay streams accept the same three socket routes
 * with the same session credentials and the same gateway lifecycle. This
 * helper owns that mapping once so a relay stream cannot reach a route, a
 * gateway, or an authorization path that the direct transport would refuse.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import { DomainError } from "./domain-error";
import { meshAcpGateway } from "./mesh-acp-gateway";
import { meshExecutionGateway } from "./mesh-execution-gateway";
import { meshTcpTunnelGateway } from "./mesh-tcp-tunnel-gateway";
import { meshTerminalGateway } from "./mesh-terminal-gateway";
import { requireMeshRuntimeRole } from "./mesh-runtime";

const log = createLogger("core:mesh-inbound-socket");

export const MESH_INBOUND_ACP_PATH = "/api/mesh/internal/execution/acp";
export const MESH_INBOUND_TERMINAL_PATH = "/api/mesh/internal/terminal";
export const MESH_INBOUND_TCP_TUNNEL_PATH = "/api/mesh/internal/tcp-tunnel";

export const MESH_INBOUND_SOCKET_PATHS: ReadonlySet<string> = new Set([
  MESH_INBOUND_ACP_PATH,
  MESH_INBOUND_TERMINAL_PATH,
  MESH_INBOUND_TCP_TUNNEL_PATH,
]);

/** The narrow socket surface every Mesh gateway needs. */
export interface MeshInboundSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface MeshInboundSocketAttachment {
  readonly path: string;
  readonly sessionId: string;
  message(data: string | Uint8Array): Promise<void>;
  close(): Promise<void>;
}

function requireSessionCredentials(
  headers: Record<string, string>,
  errorCode: string,
  message: string,
): { sessionId: string; sessionToken: string } {
  const sessionId = headers["x-clanky-mesh-session-id"];
  const sessionToken = headers["x-clanky-mesh-session-token"];
  if (!sessionId || !sessionToken) {
    throw new DomainError(errorCode, message);
  }
  return { sessionId, sessionToken };
}

function toGatewayPayload(data: string | Uint8Array): string | Buffer {
  return typeof data === "string" ? data : Buffer.from(data);
}

/**
 * Authorize an inbound Mesh socket route and attach it to its gateway.
 *
 * Resolves with the message and close callbacks that the caller must drive
 * for the lifetime of its transport.
 */
export async function openMeshInboundSocket(
  path: string,
  headers: Record<string, string>,
  socket: MeshInboundSocket,
  signal?: AbortSignal,
): Promise<MeshInboundSocketAttachment> {
  requireMeshRuntimeRole("worker");
  const pathname = new URL(
    path.startsWith("/") ? path : `/${path}`,
    "https://mesh.invalid",
  ).pathname;
  if (!MESH_INBOUND_SOCKET_PATHS.has(pathname)) {
    throw new DomainError(
      "mesh_peer_target_invalid",
      `The Mesh socket route "${pathname}" is not available.`,
    );
  }

  if (pathname === MESH_INBOUND_ACP_PATH) {
    const { sessionId, sessionToken } = requireSessionCredentials(
      headers,
      "mesh_execution_session_invalid",
      "Mesh ACP session headers are required.",
    );
    await meshExecutionGateway.getAcpSessionConfig(sessionId, sessionToken);
    await meshAcpGateway.open(socket, sessionId, sessionToken, signal);
    return {
      path: pathname,
      sessionId,
      message: async (data) => {
        await meshAcpGateway.message(sessionId, toGatewayPayload(data));
      },
      close: async () => {
        await meshAcpGateway.close(sessionId);
      },
    };
  }

  if (pathname === MESH_INBOUND_TERMINAL_PATH) {
    const { sessionId, sessionToken } = requireSessionCredentials(
      headers,
      "mesh_terminal_session_invalid",
      "Mesh terminal session headers are required.",
    );
    await meshTerminalGateway.authorize(sessionId, sessionToken);
    await meshTerminalGateway.open(socket, sessionId, sessionToken, signal);
    return {
      path: pathname,
      sessionId,
      message: async (data) => {
        await meshTerminalGateway.message(
          sessionId,
          sessionToken,
          toGatewayPayload(data),
          socket,
        );
      },
      close: async () => {
        await meshTerminalGateway.close(
          sessionId,
          false,
          1000,
          "Mesh terminal closed",
          socket,
        );
      },
    };
  }

  const { sessionId, sessionToken } = requireSessionCredentials(
    headers,
    "mesh_tunnel_session_invalid",
    "Mesh TCP tunnel headers are required.",
  );
  await meshTcpTunnelGateway.authorize(sessionId, sessionToken);
  await meshTcpTunnelGateway.open(socket, sessionId, sessionToken, signal);
  return {
    path: pathname,
    sessionId,
    message: async (data) => {
      await meshTcpTunnelGateway.message(
        sessionId,
        sessionToken,
        toGatewayPayload(data),
      );
    },
    close: async () => {
      await meshTcpTunnelGateway.close(sessionId);
    },
  };
}

/** Close an attachment without letting gateway teardown failures escape. */
export async function closeMeshInboundSocket(
  attachment: MeshInboundSocketAttachment,
): Promise<void> {
  try {
    await attachment.close();
  } catch (error) {
    log.warn("An inbound Mesh socket could not be closed cleanly", {
      path: attachment.path,
      error: String(error),
    });
  }
}
