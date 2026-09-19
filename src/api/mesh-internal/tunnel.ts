import { defineRoutes } from "@pablozaiden/webapp/server";
import { MeshTcpTunnelSessionRequestSchema } from "@/contracts/schemas/mesh-tcp-tunnel";
import { meshTcpTunnelGateway } from "../../core/mesh-tcp-tunnel-gateway";
import { encryptMeshPayload } from "../../core/mesh-payload-crypto";
import { errorResponse } from "../helpers";
import { parseAndValidate } from "../validation";
import {
  internalMeshErrorResponse,
  validateMeshIdentityHeaders,
} from "./shared";

export const meshTunnelRoutes = defineRoutes({
  "/api/mesh/internal/tcp-tunnel/session": {
    auth: "public",
    sameOrigin: "never",
    description: "Establish a signed Mesh TCP tunnel session.",
    tags: ["mesh", "internal", "tcp-tunnel"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(MeshTcpTunnelSessionRequestSchema, req);
      if (!parsed.success) return parsed.response;
      const headerError = validateMeshIdentityHeaders(
        req,
        parsed.data.callerNodeId,
        parsed.data.requestId,
        "Mesh identity headers do not match the TCP tunnel session.",
      );
      if (headerError) return headerError;
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

        return upgraded ? undefined : errorResponse("mesh_tunnel_upgrade_failed", "Mesh TCP tunnel WebSocket upgrade failed.", 400);
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
});
