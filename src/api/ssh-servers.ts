import { defineRoutes, type RouteContext } from "@pablozaiden/webapp/server";
/**
 * API endpoints for SSH execution-host registration and credential handoff.
 */

import { sshCredentialManager } from "../core/ssh-credential-manager";
import { sshServerManager } from "../core/ssh-server-manager";
import { sshServerKeyManager } from "../core/ssh-server-key-manager";
import { createLogger } from "@pablozaiden/webapp/server";
import { domainErrorResponse, errorResponse } from "./helpers";
import { parseAndValidate } from "./validation";
import {
  CreateSshServerRequestSchema,
  SshCredentialExchangeRequestSchema,
  UpdateSshServerRequestSchema,
} from "@/contracts/schemas";

const log = createLogger("api:ssh-servers");

function mapSshServerError(error: unknown): Response {
  return domainErrorResponse(error, {
    mappings: {
      ssh_server_not_found: {
        error: "not_found",
        message: "SSH server not found",
        status: 404,
      },
      invalid_encrypted_credential: {
        status: 400,
      },
      invalid_credential_token: {
        status: 400,
      },
      ssh_server_reload_failed: {
        status: 500,
        message: "Failed to reload SSH server",
      },
      ssh_server_key_generation_failed: {
        status: 500,
        message: "Failed to generate SSH server key pair",
      },
    },
    fallback: {
      error: "ssh_server_error",
      message: "SSH server operation failed",
      status: 500,
    },
  });
}

export const sshServersRoutes = defineRoutes({
  "/api/ssh-servers": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List or create standalone SSH servers.",
    requestSchema: CreateSshServerRequestSchema,
    async GET(_req: Request, _ctx: RouteContext): Promise<Response> {
      try {
        return Response.json(await sshServerManager.listServers());
      } catch (error) {
        log.error("Failed to list standalone SSH servers", { error: String(error) });
        return mapSshServerError(error);
      }
    },

    async POST(req: Request, _ctx): Promise<Response> {
      const validation = await parseAndValidate(CreateSshServerRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const server = await sshServerManager.createServer(validation.data);
        return Response.json(server, { status: 201 });
      } catch (error) {
        log.error("Failed to create standalone SSH server", { error: String(error) });
        return mapSshServerError(error);
      }
    },
  },

  "/api/ssh-servers/:id": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Update or delete a standalone SSH server.",
    requestSchema: UpdateSshServerRequestSchema,
    async GET(_req: Request, ctx): Promise<Response> {
      try {
        const server = await sshServerManager.getServer(ctx.params["id"]!);
        if (!server) {
          return errorResponse("not_found", "SSH server not found", 404);
        }
        return Response.json(server);
      } catch (error) {
        log.error("Failed to fetch standalone SSH server", {
          serverId: ctx.params["id"]!,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },

    async PATCH(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(UpdateSshServerRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        return Response.json(await sshServerManager.updateServer(ctx.params["id"]!, validation.data));
      } catch (error) {
        log.error("Failed to update standalone SSH server", {
          serverId: ctx.params["id"]!,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },

    async DELETE(_req: Request, ctx): Promise<Response> {
      try {
        const deleted = await sshServerManager.deleteServer(ctx.params["id"]!);
        if (!deleted) {
          return errorResponse("not_found", "SSH server not found", 404);
        }
        return Response.json({ success: true });
      } catch (error) {
        log.error("Failed to delete standalone SSH server", {
          serverId: ctx.params["id"]!,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },
  },

  "/api/ssh-servers/:id/public-key": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read the public key for a standalone SSH server.",
    async GET(_req: Request, ctx): Promise<Response> {
      try {
        const publicKey = await sshServerKeyManager.ensurePublicKey(ctx.params["id"]!);
        return Response.json(publicKey);
      } catch (error) {
        log.error("Failed to fetch standalone SSH server public key", {
          serverId: ctx.params["id"]!,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },
  },

  "/api/ssh-servers/:id/credentials": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Exchange an encrypted SSH credential for a temporary token.",
    requestSchema: SshCredentialExchangeRequestSchema,
    async POST(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(SshCredentialExchangeRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const exchange = await sshCredentialManager.issueToken(
          ctx.params["id"]!,
          validation.data.encryptedCredential,
        );
        return Response.json(exchange, { status: 201 });
      } catch (error) {
        log.error("Failed to exchange standalone SSH credential", {
          serverId: ctx.params["id"]!,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },
  },

});
