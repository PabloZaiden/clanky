/**
 * API endpoints for terminal sessions.
 *
 * These routes are transport-neutral and support workspace-bound or direct
 * local, SSH, and Mesh terminals.
 */

import { defineRoutes } from "@pablozaiden/webapp/server";
import { createLogger } from "@pablozaiden/webapp/server";
import { terminalSessionManager } from "../core/terminal-session-manager";
import { domainErrorResponse, errorResponse } from "./helpers";
import { parseAndValidate } from "./validation";
import { CreateTerminalSessionRequestSchema, UpdateTerminalSessionRequestSchema } from "@/contracts/schemas";
import { WorkspaceFilterQuerySchema } from "./route-schemas";
import { workspaceOperation } from "./workspace-delegation";

const log = createLogger("api:terminal-sessions");

function mapTerminalSessionError(error: unknown): Response {
  return domainErrorResponse(error, {
    policy: "terminal",
    fallback: {
      error: "terminal_session_error",
      message: "Terminal session operation failed",
      status: 500,
    },
  });
}

export const terminalSessionsRoutes = defineRoutes({
  "/api/terminal-sessions": {
    delegation: workspaceOperation("terminal", { collection: true }),
    partialResults: { header: "X-Clanky-Partial" },
    auth: "user",
    sameOrigin: "mutations",
    description: "Create a workspace terminal session.",
    requestSchema: CreateTerminalSessionRequestSchema,
    operations: {
      GET: {
        description: "List terminal sessions, optionally filtered by workspace.",
        requestSchema: undefined,
        querySchema: WorkspaceFilterQuerySchema,
        automation: { policy: "read" },
      },
      POST: {
        requestSchema: CreateTerminalSessionRequestSchema,
        querySchema: undefined,
        automation: { policy: "write" },
      },
    },
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
    delegation: workspaceOperation("terminal"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Update or delete a workspace terminal session.",
    requestSchema: UpdateTerminalSessionRequestSchema,
    operations: {
      GET: {
        description: "Read a terminal session registration.",
        requestSchema: undefined,
        querySchema: undefined,
        automation: { policy: "read" },
      },
      PATCH: {
        requestSchema: UpdateTerminalSessionRequestSchema,
        querySchema: undefined,
        automation: { policy: "write" },
      },
      DELETE: {
        requestSchema: undefined,
        querySchema: undefined,
        automation: { policy: "confirm", reason: "Deletes the terminal session and may terminate its process.", completion: "admission" },
      },
    },
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
