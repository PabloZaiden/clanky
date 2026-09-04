/**
 * Authenticated-by-signature mesh control routes.
 *
 * These routes are public at the framework boundary because a node has no
 * local user session on the peer yet. The handler requires a signed envelope,
 * matching node/request headers, endpoint policy, and explicit user approval
 * remains mandatory before membership becomes active.
 */

import { defineRoutes } from "@pablozaiden/webapp/server";
import {
  MeshHealthCheckSchema,
  MeshPeerPairingApprovalSchema,
  MeshPeerPairingRequestSchema,
  MeshMembershipUpdateSchema,
} from "@/contracts/schemas/mesh";
import {
  MeshExecutionRpcRequestSchema,
  MeshExecutionFileWriteQuerySchema,
  MeshExecutionSessionRequestSchema,
} from "@/contracts/schemas/mesh-execution";
import { MeshTerminalSessionRequestSchema } from "@/contracts/schemas/mesh-terminal";
import { MeshTcpTunnelSessionRequestSchema } from "@/contracts/schemas/mesh-tcp-tunnel";
import { meshManager } from "../core/mesh-manager";
import { consumeMeshEnrollmentToken } from "../persistence/mesh-enrollment-tokens";
import { ensureLocalMeshNodeIdentity } from "../persistence/mesh-node-identity";
import { meshExecutionGateway } from "../core/mesh-execution-gateway";
import { meshTerminalGateway } from "../core/mesh-terminal-gateway";
import { meshTcpTunnelGateway } from "../core/mesh-tcp-tunnel-gateway";
import { encryptMeshPayload } from "../core/mesh-payload-crypto";
import { errorResponse } from "./helpers";
import { parseAndValidate, validateRequest } from "./validation";
import { isDomainError } from "../core/domain-error";

function internalMeshErrorResponse(error: unknown): Response {
  if (isDomainError(error)) {
    const status = error.code === "mesh_pairing_request_expired"
      ? 410
      : error.code === "mesh_pairing_request_conflict"
        || error.code === "mesh_instance_name_conflict"
        ? 409
        : error.code === "mesh_peer_not_trusted"
          ? 403
          : error.code === "mesh_link_not_found"
            ? 404
          : error.code === "mesh_peer_revoked"
            ? 403
          : error.code === "mesh_link_revoked"
            ? 403
          : error.code === "mesh_execution_caller_not_active"
            ? 409
          : error.code === "mesh_execution_context_changed"
            ? 409
          : error.code === "mesh_execution_owner_mismatch"
            ? 403
          : error.code === "workspace_not_found"
            ? 404
          : error.code === "mesh_execution_session_invalid"
            || error.code === "mesh_execution_session_expired"
            ? 401
          : error.code === "mesh_execution_result_too_large"
            ? 413
          : error.code === "mesh_execution_operation_unsupported"
            ? 501
          : error.code === "mesh_terminal_session_invalid"
            || error.code === "mesh_terminal_session_expired"
            ? 401
          : error.code === "mesh_terminal_context_changed"
            || error.code === "mesh_terminal_target_invalid"
            ? 403
          : error.code.startsWith("mesh_terminal_")
            ? 400
          : error.code.startsWith("mesh_tunnel_")
            ? 400
          : error.code.startsWith("mesh_execution_")
            ? 400
          : error.code.startsWith("mesh_peer_") || error.code.startsWith("mesh_endpoint_")
            ? 400
            : 500;
    return errorResponse(error.code, error.message, status);
  }
  return errorResponse("mesh_internal_request_failed", "Mesh internal request failed", 500);
}

export const meshInternalRoutes = defineRoutes({
  "/api/mesh/internal/pairing-requests": {
    auth: "public",
    sameOrigin: "never",
    description: "Receive a signed mesh pairing request from another node.",
    tags: ["mesh", "internal"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(MeshPeerPairingRequestSchema, req);
      if (!parsed.success) {
        return parsed.response;
      }
      const nodeId = req.headers.get("x-clanky-mesh-node-id");
      const requestId = req.headers.get("x-clanky-mesh-request-id");
      if (nodeId !== parsed.data.requestedNodeId || requestId !== parsed.data.requestId) {
        return errorResponse("mesh_peer_headers_invalid", "Mesh identity headers do not match the signed request.", 400);
      }
      try {
        const received = await meshManager.receivePairingRequest(parsed.data);
        const enrollmentToken = req.headers.get("x-clanky-mesh-enrollment-token")?.trim();
        if (enrollmentToken) {
          const identity = await ensureLocalMeshNodeIdentity();
          const enrollment = consumeMeshEnrollmentToken(enrollmentToken, {
            nodeId: identity.nodeId,
            fingerprint: identity.fingerprint,
          });
          if (!enrollment) {
            return errorResponse(
              "mesh_enrollment_token_invalid",
              "The mesh enrollment token is invalid, expired, or already used.",
              401,
            );
          }
          await meshManager.approvePairingRequest(
            enrollment.userId,
            received.requestId,
            enrollment.linkId ? { linkId: enrollment.linkId } : {},
          );
        }
        return Response.json(received);
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
  "/api/mesh/internal/pairing-approvals": {
    auth: "public",
    sameOrigin: "never",
    description: "Receive a signed mesh pairing approval from another node.",
    tags: ["mesh", "internal"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(MeshPeerPairingApprovalSchema, req);
      if (!parsed.success) {
        return parsed.response;
      }
      const nodeId = req.headers.get("x-clanky-mesh-node-id");
      const requestId = req.headers.get("x-clanky-mesh-request-id");
      if (nodeId !== parsed.data.approvedByNodeId || requestId !== parsed.data.requestId) {
        return errorResponse("mesh_peer_headers_invalid", "Mesh identity headers do not match the signed approval.", 400);
      }
      try {
        return Response.json(await meshManager.receivePairingApproval(parsed.data));
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
  "/api/mesh/internal/membership": {
    auth: "public",
    sameOrigin: "never",
    description: "Receive a signed mesh membership metadata update from another node.",
    tags: ["mesh", "internal"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(MeshMembershipUpdateSchema, req);
      if (!parsed.success) {
        return parsed.response;
      }
      const nodeId = req.headers.get("x-clanky-mesh-node-id");
      const requestId = req.headers.get("x-clanky-mesh-request-id");
      if (nodeId !== parsed.data.senderNodeId || requestId !== parsed.data.nonce) {
        return errorResponse("mesh_peer_headers_invalid", "Mesh identity headers do not match the signed membership update.", 400);
      }
      try {
        return Response.json(await meshManager.receiveMembershipUpdate(parsed.data));
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
  "/api/mesh/internal/health": {
    auth: "public",
    sameOrigin: "never",
    description: "Receive a signed mesh transport health check from another node.",
    tags: ["mesh", "internal", "health"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(MeshHealthCheckSchema, req);
      if (!parsed.success) {
        return parsed.response;
      }
      const nodeId = req.headers.get("x-clanky-mesh-node-id");
      const requestId = req.headers.get("x-clanky-mesh-request-id");
      if (nodeId !== parsed.data.senderNodeId || requestId !== parsed.data.nonce) {
        return errorResponse("mesh_peer_headers_invalid", "Mesh identity headers do not match the signed health check.", 400);
      }
      try {
        return Response.json(await meshManager.receiveHealthCheck(parsed.data));
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
  "/api/mesh/internal/execution/session": {
    auth: "public",
    sameOrigin: "never",
    description: "Establish a signed, short-lived mesh CommandExecutor session.",
    tags: ["mesh", "internal", "execution"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(MeshExecutionSessionRequestSchema, req);
      if (!parsed.success) return parsed.response;
      if (parsed.data.callerEncryptionPublicKey.trim().length === 0) {
        return errorResponse(
          "mesh_execution_encryption_key_invalid",
          "A non-empty caller encryption public key is required.",
          400,
        );
      }
      const nodeId = req.headers.get("x-clanky-mesh-node-id");
      const requestId = req.headers.get("x-clanky-mesh-request-id");
      if (nodeId !== parsed.data.callerNodeId || requestId !== parsed.data.requestId) {
        return errorResponse("mesh_peer_headers_invalid", "Mesh identity headers do not match the execution session.", 400);
      }
      try {
        const session = await meshExecutionGateway.createSession(parsed.data);
        // Keep the bearer token plaintext out of the HTTP response body.
        return Response.json({
          protocolVersion: session.protocolVersion,
          sessionId: session.sessionId,
          expiresAt: session.expiresAt,
          encryptedPayload: encryptMeshPayload(
            { sessionToken: session.sessionToken },
            parsed.data.callerEncryptionPublicKey,
          ),
        });
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
  "/api/mesh/internal/execution/rpc": {
    auth: "public",
    sameOrigin: "never",
    description: "Execute a bounded CommandExecutor operation in a mesh session.",
    tags: ["mesh", "internal", "execution"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(MeshExecutionRpcRequestSchema, req);
      if (!parsed.success) return parsed.response;
      const sessionId = req.headers.get("x-clanky-mesh-session-id");
      const requestId = req.headers.get("x-clanky-mesh-request-id");
      if (sessionId !== parsed.data.sessionId || requestId !== parsed.data.requestId) {
        return errorResponse("mesh_peer_headers_invalid", "Mesh headers do not match the execution RPC.", 400);
      }
      try {
        const encryptionPublicKey = meshExecutionGateway.getSessionEncryptionPublicKey(
          parsed.data.sessionId,
          parsed.data.sessionToken,
        );
        const result = await meshExecutionGateway.execute(parsed.data, req.signal);
        return Response.json({
          protocolVersion: parsed.data.protocolVersion,
          requestId: parsed.data.requestId,
          encryptedPayload: encryptMeshPayload(result, encryptionPublicKey),
        });
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
  "/api/mesh/internal/execution/file": {
    auth: "public",
    sameOrigin: "never",
    description: "Stream a file from an authenticated Mesh CommandExecutor session.",
    tags: ["mesh", "internal", "execution"],
    async GET(req): Promise<Response> {
      const sessionId = req.headers.get("x-clanky-mesh-session-id");
      const sessionToken = req.headers.get("x-clanky-mesh-session-token");
      const requestedPath = new URL(req.url).searchParams.get("path");
      if (!sessionId || !sessionToken) {
        return errorResponse("mesh_execution_session_invalid", "Mesh execution session headers are required.", 401);
      }
      if (!requestedPath) {
        return errorResponse("mesh_execution_request_invalid", "A file path is required.", 400);
      }
      try {
        const stream = await meshExecutionGateway.streamFile(
          sessionId,
          sessionToken,
          requestedPath,
          req.signal,
        );
        if (!stream) {
          return errorResponse("file_not_found", "Requested file does not exist", 404);
        }
        return new Response(stream, {
          headers: {
            "cache-control": "no-store",
            "content-type": "application/octet-stream",
          },
        });
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
    async POST(req): Promise<Response> {
      const validation = validateRequest(
        MeshExecutionFileWriteQuerySchema,
        Object.fromEntries(new URL(req.url).searchParams.entries()),
      );
      if (!validation.success) {
        return validation.response;
      }
      const sessionId = req.headers.get("x-clanky-mesh-session-id");
      const sessionToken = req.headers.get("x-clanky-mesh-session-token");
      if (!sessionId || !sessionToken) {
        return errorResponse("mesh_execution_session_invalid", "Mesh execution session headers are required.", 401);
      }
      if (!req.body) {
        return errorResponse("mesh_execution_request_invalid", "A file write body is required.", 400);
      }
      try {
        const result = await meshExecutionGateway.writeFileStream(
          sessionId,
          sessionToken,
          validation.data.path,
          req.body,
          {
            append: validation.data.append,
            expectedOffset: validation.data.expectedOffset,
            maxBytes: validation.data.maxBytes,
          },
          req.signal,
        );
        return Response.json(result);
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
  "/api/mesh/internal/execution/acp": {
    auth: "public",
    sameOrigin: "never",
    description: "Open an authenticated mesh ACP relay for a CommandExecutor session.",
    tags: ["mesh", "internal", "execution", "acp"],
    async GET(req, ctx): Promise<Response | undefined> {
      const sessionId = req.headers.get("x-clanky-mesh-session-id");
      const sessionToken = req.headers.get("x-clanky-mesh-session-token");
      if (!sessionId || !sessionToken) {
        return errorResponse("mesh_execution_session_invalid", "Mesh ACP session headers are required.", 401);
      }
      try {
        await meshExecutionGateway.getAcpSessionConfig(sessionId, sessionToken);
        const upgraded = ctx.server?.upgrade(req, {
          data: {
            webappSocketHandler: "clanky",
            meshAcpMode: true,
            meshAcpSessionId: sessionId,
            meshAcpSessionToken: sessionToken,
          },
        });
        return upgraded ? undefined : errorResponse("mesh_acp_upgrade_failed", "Mesh ACP WebSocket upgrade failed.", 400);
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
  "/api/mesh/internal/terminal/session": {
    auth: "public",
    sameOrigin: "never",
    description: "Establish a signed, encrypted Mesh interactive terminal session.",
    tags: ["mesh", "internal", "terminal"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(MeshTerminalSessionRequestSchema, req);
      if (!parsed.success) return parsed.response;
      const nodeId = req.headers.get("x-clanky-mesh-node-id");
      const requestId = req.headers.get("x-clanky-mesh-request-id");
      if (nodeId !== parsed.data.callerNodeId || requestId !== parsed.data.requestId) {
        return errorResponse("mesh_peer_headers_invalid", "Mesh identity headers do not match the terminal session.", 400);
      }
      try {
        const session = await meshTerminalGateway.createSession(parsed.data);
        return Response.json({
          protocolVersion: session.protocolVersion,
          capability: session.capability,
          sessionId: session.sessionId,
          expiresAt: session.expiresAt,
          encryptedPayload: encryptMeshPayload(
            { sessionToken: session.sessionToken },
            parsed.data.callerEncryptionPublicKey,
          ),
        });
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
  "/api/mesh/internal/terminal": {
    auth: "public",
    sameOrigin: "never",
    description: "Open an authenticated Mesh interactive terminal stream.",
    tags: ["mesh", "internal", "terminal"],
    async GET(req, ctx): Promise<Response | undefined> {
      const sessionId = req.headers.get("x-clanky-mesh-session-id");
      const sessionToken = req.headers.get("x-clanky-mesh-session-token");
      if (!sessionId || !sessionToken) {
        return errorResponse("mesh_terminal_session_invalid", "Mesh terminal session headers are required.", 401);
      }
      try {
        await meshTerminalGateway.authorize(sessionId, sessionToken);
        const upgraded = ctx.server?.upgrade(req, {
          data: {
            webappSocketHandler: "clanky",
            meshTerminalMode: true,
            meshTerminalSessionId: sessionId,
            meshTerminalSessionToken: sessionToken,
          },
        });
        return upgraded ? undefined : errorResponse("mesh_terminal_upgrade_failed", "Mesh terminal WebSocket upgrade failed.", 400);
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
  "/api/mesh/internal/tcp-tunnel/session": {
    auth: "public",
    sameOrigin: "never",
    description: "Establish a signed Mesh TCP tunnel session.",
    tags: ["mesh", "internal", "tcp-tunnel"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(MeshTcpTunnelSessionRequestSchema, req);
      if (!parsed.success) return parsed.response;
      const nodeId = req.headers.get("x-clanky-mesh-node-id");
      const requestId = req.headers.get("x-clanky-mesh-request-id");
      if (nodeId !== parsed.data.callerNodeId || requestId !== parsed.data.requestId) {
        return errorResponse("mesh_peer_headers_invalid", "Mesh identity headers do not match the TCP tunnel session.", 400);
      }
      try {
        const session = await meshTcpTunnelGateway.createSession(parsed.data);
        return Response.json({
          protocolVersion: session.protocolVersion,
          capability: session.capability,
          sessionId: session.sessionId,
          expiresAt: session.expiresAt,
          encryptedPayload: encryptMeshPayload(
            { sessionToken: session.sessionToken },
            parsed.data.callerEncryptionPublicKey,
          ),
        });
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
  "/api/mesh/internal/tcp-tunnel": {
    auth: "public",
    sameOrigin: "never",
    description: "Open an authenticated Mesh TCP tunnel stream.",
    tags: ["mesh", "internal", "tcp-tunnel"],
    async GET(req, ctx): Promise<Response | undefined> {
      const sessionId = req.headers.get("x-clanky-mesh-session-id");
      const sessionToken = req.headers.get("x-clanky-mesh-session-token");
      if (!sessionId || !sessionToken) {
        return errorResponse("mesh_tunnel_session_invalid", "Mesh TCP tunnel headers are required.", 401);
      }
      try {
        await meshTcpTunnelGateway.authorize(sessionId, sessionToken);
        const upgraded = ctx.server?.upgrade(req, {
          data: {
            webappSocketHandler: "clanky",
            meshTcpTunnelMode: true,
            meshTcpTunnelSessionId: sessionId,
            meshTcpTunnelSessionToken: sessionToken,
          },
        });
        return upgraded ? undefined : errorResponse("mesh_tunnel_upgrade_failed", "Mesh TCP tunnel upgrade failed.", 400);
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
});
