import { vncSessionManager } from "../core/vnc-session-manager";
import { createLogger } from "../core/logger";
import { CreateVncSessionRequestSchema } from "../types/schemas";
import { parseAndValidate } from "./validation";
import { errorResponse, successResponse } from "./helpers";

const log = createLogger("api:vnc-sessions");

function mapVncError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("not found")) {
    return errorResponse("not_found", message, 404);
  }
  if (message.includes("credential token")) {
    return errorResponse("invalid_credential_token", message, 400);
  }
  return errorResponse("vnc_session_error", message, 500);
}

export const vncSessionRoutes = {
  "/api/ssh-servers/:id/vnc-sessions": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      try {
        return Response.json(await vncSessionManager.listServerSessions(req.params.id));
      } catch (error) {
        log.error("Failed to list VNC sessions", { serverId: req.params.id, error: String(error) });
        return mapVncError(error);
      }
    },

    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = await parseAndValidate(CreateVncSessionRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const session = await vncSessionManager.createOrResumeSession({
          sshServerId: req.params.id,
          remotePort: validation.data.remotePort,
          credentialToken: validation.data.credentialToken,
        });
        return Response.json(session, { status: session.state.status === "active" ? 201 : 200 });
      } catch (error) {
        log.error("Failed to create VNC session", { serverId: req.params.id, error: String(error) });
        return mapVncError(error);
      }
    },
  },

  "/api/vnc-sessions/:id": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      try {
        const session = await vncSessionManager.getSession(req.params.id);
        if (!session) {
          return errorResponse("not_found", "VNC session not found", 404);
        }
        return Response.json(session);
      } catch (error) {
        log.error("Failed to get VNC session", { vncSessionId: req.params.id, error: String(error) });
        return mapVncError(error);
      }
    },

    async DELETE(req: Request & { params: { id: string } }): Promise<Response> {
      try {
        const deleted = await vncSessionManager.closeSession(req.params.id);
        if (!deleted) {
          return errorResponse("not_found", "VNC session not found", 404);
        }
        return successResponse();
      } catch (error) {
        log.error("Failed to close VNC session", { vncSessionId: req.params.id, error: String(error) });
        return mapVncError(error);
      }
    },
  },
};
