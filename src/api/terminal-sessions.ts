/**
 * API endpoints for workspace terminal sessions.
 *
 * These routes are transport-neutral — they work with local stdio, SSH, and
 * Mesh workspace terminals. Standalone SSH-server sessions remain SSH-specific.
 */

import { defineRoutes } from "@pablozaiden/webapp/server";
import { createLogger } from "@pablozaiden/webapp/server";
import { terminalSessionManager } from "../core/terminal-session-manager";
import { domainErrorResponse, errorResponse } from "./helpers";
import { parseAndValidate } from "./validation";
import { CreateTerminalSessionRequestSchema, UpdateTerminalSessionRequestSchema } from "@/contracts/schemas";

const log = createLogger("api:terminal-sessions");

function mapTerminalSessionError(error: unknown): Response {
  return domainErrorResponse(error, {
    mappings: {
      workspace_not_found: {
        error: "not_found",
        message: "Workspace not found",
        status: 404,
      },
      terminal_session_not_found: {
        error: "not_found",
        message: "Terminal session not found",
        status: 404,
      },
      task_not_found: {
        error: "not_found",
        message: "Task not found",
        status: 404,
      },
      task_working_directory_unavailable: {
        error: "invalid_session_configuration",
        status: 400,
      },
    },
    fallback: {
      error: "terminal_session_error",
      message: "Terminal session operation failed",
      status: 500,
    },
  });
}

export const terminalSessionsRoutes = defineRoutes({
  "/api/terminal-sessions": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Create a workspace terminal session.",
    requestSchema: CreateTerminalSessionRequestSchema,
    async GET(req: Request, _ctx): Promise<Response> {
      const url = new URL(req.url);
      const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
      try {
        const sessions = await terminalSessionManager.listSessions(workspaceId);
        return Response.json(sessions);
      } catch (error) {
        log.error("Failed to list terminal sessions", { error: String(error), workspaceId });
        return mapTerminalSessionError(error);
      }
    },

    async POST(req: Request, _ctx): Promise<Response> {
      const validation = await parseAndValidate(CreateTerminalSessionRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const session = await terminalSessionManager.createSession(validation.data);
        return Response.json(session, { status: 201 });
      } catch (error) {
        log.error("Failed to create terminal session", { error: String(error) });
        return mapTerminalSessionError(error);
      }
    },
  },

  "/api/terminal-sessions/:id": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Update or delete a workspace terminal session.",
    requestSchema: UpdateTerminalSessionRequestSchema,
    async GET(_req: Request, ctx): Promise<Response> {
      try {
        const session = await terminalSessionManager.getSession(ctx.params["id"]!);
        if (!session) {
          return errorResponse("not_found", "Terminal session not found", 404);
        }
        return Response.json(session);
      } catch (error) {
        log.error("Failed to fetch terminal session", { error: String(error), id: ctx.params["id"]! });
        return mapTerminalSessionError(error);
      }
    },

    async PATCH(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(UpdateTerminalSessionRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const session = await terminalSessionManager.updateSession(ctx.params["id"]!, validation.data);
        return Response.json(session);
      } catch (error) {
        log.error("Failed to update terminal session", { error: String(error), id: ctx.params["id"]! });
        return mapTerminalSessionError(error);
      }
    },

    async DELETE(_req: Request, ctx): Promise<Response> {
      try {
        const deleted = await terminalSessionManager.deleteSession(ctx.params["id"]!);
        if (!deleted) {
          return errorResponse("not_found", "Terminal session not found", 404);
        }
        return Response.json({ success: true });
      } catch (error) {
        log.error("Failed to delete terminal session", { error: String(error), id: ctx.params["id"]! });
        return mapTerminalSessionError(error);
      }
    },
  },
});
