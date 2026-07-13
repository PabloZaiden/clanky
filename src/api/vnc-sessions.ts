import { defineRoutes } from "@pablozaiden/webapp/server";
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

export const vncSessionRoutes = defineRoutes({
  "/api/ssh-servers/:id/vnc-sessions": {
    description: "List or create VNC sessions for a standalone SSH server.",
    requestSchema: CreateVncSessionRequestSchema,
    async GET(_req: Request, ctx): Promise<Response> {
      try {
        return Response.json(await vncSessionManager.listServerSessions(ctx.params["id"]!));
      } catch (error) {
        log.error("Failed to list VNC sessions", { serverId: ctx.params["id"]!, error: String(error) });
        return mapVncError(error);
      }
    },

    async POST(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(CreateVncSessionRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const session = await vncSessionManager.createOrResumeSession({
          sshServerId: ctx.params["id"]!,
          remotePort: validation.data.remotePort,
          credentialToken: validation.data.credentialToken,
        });
        return Response.json(session, { status: session.state.status === "active" ? 201 : 200 });
      } catch (error) {
        log.error("Failed to create VNC session", { serverId: ctx.params["id"]!, error: String(error) });
        return mapVncError(error);
      }
    },
  },

  "/api/vnc-sessions/:id": {
    description: "Read or close a VNC session.",
    async GET(_req: Request, ctx): Promise<Response> {
      try {
        const session = await vncSessionManager.getSession(ctx.params["id"]!);
        if (!session) {
          return errorResponse("not_found", "VNC session not found", 404);
        }
        return Response.json(session);
      } catch (error) {
        log.error("Failed to get VNC session", { vncSessionId: ctx.params["id"]!, error: String(error) });
        return mapVncError(error);
      }
    },

    async DELETE(_req: Request, ctx): Promise<Response> {
      try {
        const deleted = await vncSessionManager.closeSession(ctx.params["id"]!);
        if (!deleted) {
          return errorResponse("not_found", "VNC session not found", 404);
        }
        return successResponse();
      } catch (error) {
        log.error("Failed to close VNC session", { vncSessionId: ctx.params["id"]!, error: String(error) });
        return mapVncError(error);
      }
    },
  },
});
