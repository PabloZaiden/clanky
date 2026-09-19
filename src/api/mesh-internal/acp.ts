import { defineRoutes } from "@pablozaiden/webapp/server";
import { MESH_EXECUTION_PROTOCOL_VERSION } from "@/shared/mesh-execution";
import { meshExecutionGateway } from "../../core/mesh-execution-gateway";
import { meshAcpGateway } from "../../core/mesh-acp-gateway";
import { requireMeshRuntimeRole } from "../../core/mesh-runtime";
import { errorResponse } from "../helpers";
import { internalMeshErrorResponse } from "./shared";

export const meshAcpRoutes = defineRoutes({
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
  "/api/mesh/internal/execution/acp/renew": {
    auth: "public",
    sameOrigin: "never",
    description: "Renew an authenticated mesh ACP relay lease.",
    tags: ["mesh", "internal", "execution", "acp"],
    async POST(req): Promise<Response> {
      const sessionId = req.headers.get("x-clanky-mesh-session-id");
      const sessionToken = req.headers.get("x-clanky-mesh-session-token");
      if (!sessionId || !sessionToken) {
        return errorResponse("mesh_execution_session_invalid", "Mesh ACP session headers are required.", 401);
      }
      try {
        requireMeshRuntimeRole("worker");
        const expiresAt = await meshAcpGateway.renew(sessionId, sessionToken);
        return Response.json({
          protocolVersion: MESH_EXECUTION_PROTOCOL_VERSION,
          sessionId,
          expiresAt: new Date(expiresAt).toISOString(),
        });
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
});
