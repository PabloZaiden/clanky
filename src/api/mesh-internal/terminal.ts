import { defineRoutes } from "@pablozaiden/webapp/server";
import {
  MeshTerminalSessionCloseRequestSchema,
  MeshTerminalSessionRequestSchema,
} from "@/contracts/schemas/mesh-terminal";
import { meshTerminalGateway } from "../../core/mesh-terminal-gateway";
import { encodeMeshPayload } from "../../core/mesh-payload";
import { assertMeshRequestTransport } from "../../core/mesh-transport-security";
import { DomainError } from "../../domain/domain-error";
import { requireMeshRuntimeRole } from "../../core/mesh-runtime";
import { errorResponse } from "../helpers";
import { parseAndValidate } from "../validation";
import {
  internalMeshErrorResponse,
  validateMeshIdentityHeaders,
  validateMeshSessionHeaders,
} from "./shared";

export const meshTerminalRoutes = defineRoutes({
  "/api/mesh/internal/terminal/session": {
    auth: "public",
    sameOrigin: "never",
    description: "Establish a signed, encrypted Mesh interactive terminal session.",
    operations: {
      POST: { requestSchema: undefined, querySchema: undefined, automation: { policy: "excluded", reason: "Signed internal Mesh interactive-terminal admission protocol." } },
      DELETE: { requestSchema: undefined, querySchema: undefined, automation: { policy: "excluded", reason: "Signed internal Mesh interactive-terminal teardown protocol." } },
    },
    tags: ["mesh", "internal", "terminal"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(MeshTerminalSessionRequestSchema, req);
      if (!parsed.success) return parsed.response;
      const headerError = validateMeshIdentityHeaders(
        req,
        parsed.data.callerNodeId,
        parsed.data.requestId,
        "Mesh identity headers do not match the terminal session.",
      );
      if (headerError) return headerError;
      try {
        assertMeshRequestTransport(req, parsed.data.protocolVersion);
        const session = await meshTerminalGateway.createSession(parsed.data);
        return Response.json({
          protocolVersion: session.protocolVersion,
          capability: session.capability,
          sessionId: session.sessionId,
          expiresAt: session.expiresAt,
          ...encodeMeshPayload(
            session.protocolVersion,
            { sessionToken: session.sessionToken },
            parsed.data.callerEncryptionPublicKey,
          ),
        });
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
    async DELETE(req): Promise<Response> {
      const parsed = await parseAndValidate(
        MeshTerminalSessionCloseRequestSchema,
        req,
      );
      if (!parsed.success) return parsed.response;
      const headerError = validateMeshSessionHeaders(
        req,
        parsed.data.sessionId,
        parsed.data.requestId,
        "Mesh headers do not match the terminal session release.",
      );
      if (headerError) return headerError;
      try {
        const version = meshTerminalGateway.getSessionProtocolVersion(parsed.data.sessionId, parsed.data.sessionToken)
          ?? parsed.data.protocolVersion;
        assertMeshRequestTransport(req, version);
        if (version !== parsed.data.protocolVersion) {
          throw new DomainError("mesh_execution_protocol_mismatch", "The terminal release generation does not match its admitted session.");
        }
        requireMeshRuntimeRole("worker");
        await meshTerminalGateway.releaseSession(
          parsed.data.sessionId,
          parsed.data.sessionToken,
        );
        return Response.json({ success: true });
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
  "/api/mesh/internal/terminal": {
    auth: "public",
    sameOrigin: "never",
    description: "Open an authenticated Mesh interactive terminal stream.",
    operations: {
      GET: { requestSchema: undefined, querySchema: undefined, automation: { policy: "excluded", reason: "Raw authenticated internal Mesh terminal WebSocket transport." } },
    },
    tags: ["mesh", "internal", "terminal"],
    async GET(req, ctx): Promise<Response | undefined> {
      const sessionId = req.headers.get("x-clanky-mesh-session-id");
      const sessionToken = req.headers.get("x-clanky-mesh-session-token");
      if (!sessionId || !sessionToken) {
        return errorResponse("mesh_terminal_session_invalid", "Mesh terminal session headers are required.", 401);
      }
      try {
        assertMeshRequestTransport(req, await meshTerminalGateway.authorize(sessionId, sessionToken));
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
});
