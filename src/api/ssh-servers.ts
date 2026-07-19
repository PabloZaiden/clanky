import { defineRoutes, type RouteContext } from "@pablozaiden/webapp/server";
/**
 * API endpoints for standalone SSH server key and credential handoff flows.
 */

import { sshCredentialManager } from "../core/ssh-credential-manager";
import { chatManager } from "../core/chat-manager";
import { sshServerManager } from "../core/ssh-server-manager";
import { sshServerKeyManager } from "../core/ssh-server-key-manager";
import { createLogger } from "@pablozaiden/webapp/server";
import { domainErrorResponse, errorResponse } from "./helpers";
import { parseAndValidate } from "./validation";
import { CheckSshServerPrerequisitesRequestSchema, CreateSshServerChatRequestSchema, CreateSshServerRequestSchema, CreateSshServerSessionRequestSchema, GetDevboxTemplatesRequestSchema, DiscoverSshServerChatProvidersRequestSchema, DiscoverSshServerChatModelsRequestSchema, DeleteSshServerSessionRequestSchema, SshCredentialExchangeRequestSchema, UpdateSshServerRequestSchema, UpdateSshSessionRequestSchema } from "@/contracts/schemas";
import { getModelsForSettings } from "../core/model-discovery";
import { buildProviderAvailabilityShellCheck } from "../core/agent-runtime-command";
import { AGENT_PROVIDER_IDS } from "../constants/agent-providers";
import type { ServerSettings } from "@/shared/settings";

const log = createLogger("api:ssh-servers");

function mapSshServerError(error: unknown): Response {
  return domainErrorResponse(error, {
    mappings: {
      ssh_server_not_found: {
        error: "not_found",
        message: "SSH server not found",
        status: 404,
      },
      ssh_server_session_not_found: {
        error: "not_found",
        message: "SSH server session not found",
        status: 404,
      },
      invalid_encrypted_credential: {
        status: 400,
      },
      invalid_credential_token: {
        status: 400,
      },
      ssh_server_templates_failed: {
        status: 500,
        message: "Failed to list devbox templates",
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

  "/api/ssh-servers/:id/sessions": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List or create standalone SSH server sessions.",
    requestSchema: CreateSshServerSessionRequestSchema,
    async GET(_req: Request, ctx): Promise<Response> {
      try {
        return Response.json(await sshServerManager.listSessions(ctx.params["id"]!));
      } catch (error) {
        log.error("Failed to list standalone SSH server sessions", {
          serverId: ctx.params["id"]!,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },

    async POST(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(CreateSshServerSessionRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const session = await sshServerManager.createSession(ctx.params["id"]!, validation.data);
        return Response.json(session, { status: 201 });
      } catch (error) {
        log.error("Failed to create standalone SSH server session", {
          serverId: ctx.params["id"]!,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },
  },

  "/api/ssh-servers/:id/chats": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List or create chats owned by a standalone SSH server.",
    requestSchema: CreateSshServerChatRequestSchema,
    async GET(_req: Request, ctx): Promise<Response> {
      try {
        const server = await sshServerManager.getServer(ctx.params["id"]!);
        if (!server) {
          return errorResponse("not_found", "SSH server not found", 404);
        }
        return Response.json(await chatManager.getChatSummariesBySshServer(ctx.params["id"]!));
      } catch (error) {
        log.error("Failed to list SSH-server chats", {
          serverId: ctx.params["id"]!,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },

    async POST(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(CreateSshServerChatRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const chat = await chatManager.createSshServerChat({
          sshServerId: ctx.params["id"]!,
          name: validation.data.name,
          directory: validation.data.directory,
          modelProviderID: validation.data.model.providerID,
          modelID: validation.data.model.modelID,
          modelVariant: validation.data.model.variant,
          autoApprovePermissions: validation.data.autoApprovePermissions,
          credentialToken: validation.data.credentialToken,
        });
        return Response.json(chat, { status: 201 });
      } catch (error) {
        log.error("Failed to create SSH-server chat", {
          serverId: ctx.params["id"]!,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },
  },

  "/api/ssh-servers/:id/chat-providers": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Discover ACP chat providers available on a standalone SSH server.",
    requestSchema: DiscoverSshServerChatProvidersRequestSchema,
    async POST(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(DiscoverSshServerChatProvidersRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const server = await sshServerManager.getServer(ctx.params["id"]!);
        if (!server) {
          return errorResponse("not_found", "SSH server not found", 404);
        }
        const password = sshCredentialManager.getPasswordForToken(ctx.params["id"]!, validation.data.credentialToken);
        const { executor } = await sshServerManager.getCommandExecutor(ctx.params["id"]!, password);
        const availabilityResults = await Promise.all(
          AGENT_PROVIDER_IDS.map((providerID) => (
            executor.exec("sh", ["-lc", buildProviderAvailabilityShellCheck(providerID)])
          )),
        );
        return Response.json({
          providers: AGENT_PROVIDER_IDS.map((providerID, index) => ({
            providerID,
            available: availabilityResults[index]!.success,
          })),
        });
      } catch (error) {
        log.error("Failed to discover SSH-server chat providers", {
          serverId: ctx.params["id"]!,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },
  },

  "/api/ssh-servers/:id/chat-models": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Discover ACP chat models for a selected provider on a standalone SSH server.",
    requestSchema: DiscoverSshServerChatModelsRequestSchema,
    async POST(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(DiscoverSshServerChatModelsRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const server = await sshServerManager.getServer(ctx.params["id"]!);
        if (!server) {
          return errorResponse("not_found", "SSH server not found", 404);
        }
        const password = sshCredentialManager.getPasswordForToken(ctx.params["id"]!, validation.data.credentialToken);
        const settings: ServerSettings = {
          agent: {
            provider: validation.data.providerID,
            transport: "ssh",
            hostname: server.config.address,
            port: 22,
            username: server.config.username,
            password,
          },
        };
        const models = await getModelsForSettings(
          `ssh-server:${ctx.params["id"]!}:${validation.data.providerID}`,
          validation.data.directory,
          settings,
        );
        return Response.json(models.filter((model) => model.providerID === validation.data.providerID));
      } catch (error) {
        log.error("Failed to discover SSH-server chat models", {
          serverId: ctx.params["id"]!,
          providerID: validation.success ? validation.data.providerID : undefined,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },
  },

  "/api/ssh-servers/:id/prerequisites/check": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Run prerequisite checks for a standalone SSH server.",
    requestSchema: CheckSshServerPrerequisitesRequestSchema,
    async POST(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(CheckSshServerPrerequisitesRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        return Response.json(await sshServerManager.checkPrerequisites(ctx.params["id"]!, validation.data));
      } catch (error) {
        log.error("Failed to check standalone SSH server prerequisites", {
          serverId: ctx.params["id"]!,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },
  },

  "/api/ssh-servers/:id/devbox/templates": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List available devbox templates for a standalone SSH server.",
    async POST(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(GetDevboxTemplatesRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        return Response.json(await sshServerManager.listDevboxTemplates(ctx.params["id"]!, validation.data));
      } catch (error) {
        log.error("Failed to list standalone SSH server devbox templates", {
          serverId: ctx.params["id"]!,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },
  },

  "/api/ssh-server-sessions/:id": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read, update, or delete a standalone SSH server session.",
    requestSchema: UpdateSshSessionRequestSchema,
    async GET(_req: Request, ctx): Promise<Response> {
      try {
        const session = await sshServerManager.getSession(ctx.params["id"]!);
        if (!session) {
          return errorResponse("not_found", "SSH server session not found", 404);
        }
        return Response.json(session);
      } catch (error) {
        log.error("Failed to fetch standalone SSH server session", {
          sshServerSessionId: ctx.params["id"]!,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },

    async PATCH(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(UpdateSshSessionRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        return Response.json(await sshServerManager.updateSession(ctx.params["id"]!, validation.data));
      } catch (error) {
        log.error("Failed to update standalone SSH server session", {
          sshServerSessionId: ctx.params["id"]!,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },

    async DELETE(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(DeleteSshServerSessionRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const deleted = await sshServerManager.deleteSession(ctx.params["id"]!, validation.data);
        if (!deleted) {
          return errorResponse("not_found", "SSH server session not found", 404);
        }
        return Response.json({ success: true });
      } catch (error) {
        log.error("Failed to delete standalone SSH server session", {
          sshServerSessionId: ctx.params["id"]!,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },
  },
});
