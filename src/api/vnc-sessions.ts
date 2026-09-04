import { defineRoutes } from "@pablozaiden/webapp/server";
import { vncSessionManager } from "../core/vnc-session-manager";
import { createLogger } from "@pablozaiden/webapp/server";
import { CreateVncSessionRequestSchema } from "@/contracts/schemas";
import { parseAndValidate } from "./validation";
import { domainErrorResponse, errorResponse, successResponse } from "./helpers";
import type { ExecutionHostRef } from "@/shared";

const log = createLogger("api:vnc-sessions");

function parseExecutionHostRef(kind: string, id: string): ExecutionHostRef | null {
  if (kind === "local" || kind === "mesh") {
    return { kind, nodeId: id };
  }
  return kind === "ssh" ? { kind, serverId: id } : null;
}

function mapVncError(error: unknown): Response {
  return domainErrorResponse(error, {
    mappings: {
      ssh_server_not_found: {
        error: "not_found",
        message: "SSH server not found",
        status: 404,
      },
      vnc_session_not_found: {
        error: "not_found",
        message: "VNC session not found",
        status: 404,
      },
      invalid_credential_token: {
        status: 400,
      },
      vnc_session_not_active: {
        status: 409,
      },
      vnc_session_start_failed: {
        status: 500,
        message: "Failed to start VNC session",
      },
      vnc_tunnel_failed: {
        status: 500,
        message: "VNC tunnel failed to start",
      },
    },
    fallback: {
      error: "vnc_session_error",
      message: "VNC session operation failed",
      status: 500,
    },
  });
}

export const vncSessionRoutes = defineRoutes({
  "/api/execution-hosts/:kind/:id/vnc-sessions": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List or create VNC sessions for an execution host.",
    requestSchema: CreateVncSessionRequestSchema,
    async GET(_req: Request, ctx): Promise<Response> {
      const ref = parseExecutionHostRef(ctx.params["kind"]!, ctx.params["id"]!);
      if (!ref) {
        return errorResponse("execution_host_kind_invalid", "Invalid execution host kind", 400);
      }
      try {
        return Response.json(await vncSessionManager.listHostSessions(ref));
      } catch (error) {
        log.error("Failed to list execution-host VNC sessions", {
          kind: ref.kind,
          error: String(error),
        });
        return mapVncError(error);
      }
    },
    async POST(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(CreateVncSessionRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }
      const ref = parseExecutionHostRef(ctx.params["kind"]!, ctx.params["id"]!);
      if (!ref) {
        return errorResponse("execution_host_kind_invalid", "Invalid execution host kind", 400);
      }
      try {
        const session = await vncSessionManager.createOrResumeSession({
          executionHost: ref,
          remotePort: validation.data.remotePort,
          credentialToken: validation.data.credentialToken,
        });
        return Response.json(session, { status: session.state.status === "active" ? 201 : 200 });
      } catch (error) {
        log.error("Failed to create execution-host VNC session", {
          kind: ref.kind,
          error: String(error),
        });
        return mapVncError(error);
      }
    },
  },
  "/api/ssh-servers/:id/vnc-sessions": {
    auth: "user",
    sameOrigin: "mutations",
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
    auth: "user",
    sameOrigin: "mutations",
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
