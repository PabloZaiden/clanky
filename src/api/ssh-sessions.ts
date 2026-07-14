import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * API endpoints for persistent SSH sessions.
 */

import { createLogger } from "../core/logger";
import { sshSessionManager } from "../core/ssh-session-manager";
import { errorResponse } from "./helpers";
import { parseAndValidate } from "./validation";
import { CreateSshSessionRequestSchema, UpdateSshSessionRequestSchema } from "@/contracts/schemas";

const log = createLogger("api:ssh-sessions");

function mapSessionError(error: unknown): Response {
  const message = String(error);
  if (message.includes("not found")) {
    return errorResponse("not_found", message, 404);
  }
  if (
    message.includes("ssh transport")
    || message.includes("dtach is not available")
    || message.includes("dtach is not installed")
  ) {
    return errorResponse("invalid_session_configuration", message, 400);
  }
  return errorResponse("ssh_session_error", message, 500);
}

export const sshSessionsRoutes = defineRoutes({
  "/api/ssh-sessions": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Create a workspace-backed SSH session.",
    requestSchema: CreateSshSessionRequestSchema,
    async GET(req: Request, _ctx): Promise<Response> {
      const url = new URL(req.url);
      const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
      try {
        const sessions = await sshSessionManager.listSessions(workspaceId);
        return Response.json(sessions);
      } catch (error) {
        log.error("Failed to list SSH sessions", { error: String(error), workspaceId });
        return mapSessionError(error);
      }
    },

    async POST(req: Request, _ctx): Promise<Response> {
      const validation = await parseAndValidate(CreateSshSessionRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const session = await sshSessionManager.createSession(validation.data);
        return Response.json(session, { status: 201 });
      } catch (error) {
        log.error("Failed to create SSH session", { error: String(error) });
        return mapSessionError(error);
      }
    },
  },

  "/api/ssh-sessions/:id": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Update or delete a workspace-backed SSH session.",
    requestSchema: UpdateSshSessionRequestSchema,
    async GET(_req: Request, ctx): Promise<Response> {
      try {
        const session = await sshSessionManager.getSession(ctx.params["id"]!);
        if (!session) {
          return errorResponse("not_found", "SSH session not found", 404);
        }
        return Response.json(session);
      } catch (error) {
        log.error("Failed to fetch SSH session", { error: String(error), id: ctx.params["id"]! });
        return mapSessionError(error);
      }
    },

    async PATCH(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(UpdateSshSessionRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const session = await sshSessionManager.updateSession(ctx.params["id"]!, validation.data);
        return Response.json(session);
      } catch (error) {
        log.error("Failed to update SSH session", { error: String(error), id: ctx.params["id"]! });
        return mapSessionError(error);
      }
    },

    async DELETE(_req: Request, ctx): Promise<Response> {
      try {
        const deleted = await sshSessionManager.deleteSession(ctx.params["id"]!);
        if (!deleted) {
          return errorResponse("not_found", "SSH session not found", 404);
        }
        return Response.json({ success: true });
      } catch (error) {
        log.error("Failed to delete SSH session", { error: String(error), id: ctx.params["id"]! });
        return mapSessionError(error);
      }
    },
  },
});
