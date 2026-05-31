/**
 * API endpoints for standalone SSH server key and credential handoff flows.
 */

import { sshCredentialManager } from "../core/ssh-credential-manager";
import { chatManager } from "../core/chat-manager";
import { sshServerManager } from "../core/ssh-server-manager";
import { sshServerKeyManager } from "../core/ssh-server-key-manager";
import { createLogger } from "../core/logger";
import { errorResponse } from "./helpers";
import { parseAndValidate } from "./validation";
import {
  CheckSshServerPrerequisitesRequestSchema,
  CreateSshServerChatRequestSchema,
  CreateSshServerRequestSchema,
  CreateSshServerSessionRequestSchema,
  GetDevboxTemplatesRequestSchema,
  DiscoverSshServerChatProvidersRequestSchema,
  DiscoverSshServerChatModelsRequestSchema,
  DeleteSshServerSessionRequestSchema,
  SshCredentialExchangeRequestSchema,
  UpdateSshServerRequestSchema,
  UpdateSshSessionRequestSchema,
} from "../types/schemas";
import { getModelsForSettings } from "./models";
import { buildProviderAvailabilityShellCheck } from "../core/agent-runtime-command";
import type { ServerSettings } from "../types/settings";

const log = createLogger("api:ssh-servers");

function mapSshServerError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("SSH server not found")) {
    return errorResponse("not_found", message, 404);
  }
  if (message.includes("SSH server session not found")) {
    return errorResponse("not_found", message, 404);
  }
  if (
    message.includes("does not match the current registered server key")
    || message.includes("algorithm does not match")
    || message.includes("oaep decoding error")
  ) {
    return errorResponse("invalid_encrypted_credential", message, 400);
  }
  if (message.includes("credential token")) {
    return errorResponse("invalid_credential_token", message, 400);
  }
  return errorResponse("ssh_server_error", message, 500);
}

export const sshServersRoutes = {
  "/api/ssh-servers": {
    async GET(): Promise<Response> {
      try {
        return Response.json(await sshServerManager.listServers());
      } catch (error) {
        log.error("Failed to list standalone SSH servers", { error: String(error) });
        return mapSshServerError(error);
      }
    },

    async POST(req: Request): Promise<Response> {
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
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      try {
        const server = await sshServerManager.getServer(req.params.id);
        if (!server) {
          return errorResponse("not_found", "SSH server not found", 404);
        }
        return Response.json(server);
      } catch (error) {
        log.error("Failed to fetch standalone SSH server", {
          serverId: req.params.id,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },

    async PATCH(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = await parseAndValidate(UpdateSshServerRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        return Response.json(await sshServerManager.updateServer(req.params.id, validation.data));
      } catch (error) {
        log.error("Failed to update standalone SSH server", {
          serverId: req.params.id,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },

    async DELETE(req: Request & { params: { id: string } }): Promise<Response> {
      try {
        const deleted = await sshServerManager.deleteServer(req.params.id);
        if (!deleted) {
          return errorResponse("not_found", "SSH server not found", 404);
        }
        return Response.json({ success: true });
      } catch (error) {
        log.error("Failed to delete standalone SSH server", {
          serverId: req.params.id,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },
  },

  "/api/ssh-servers/:id/public-key": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      try {
        const publicKey = await sshServerKeyManager.ensurePublicKey(req.params.id);
        return Response.json(publicKey);
      } catch (error) {
        log.error("Failed to fetch standalone SSH server public key", {
          serverId: req.params.id,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },
  },

  "/api/ssh-servers/:id/credentials": {
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = await parseAndValidate(SshCredentialExchangeRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const exchange = await sshCredentialManager.issueToken(
          req.params.id,
          validation.data.encryptedCredential,
        );
        return Response.json(exchange, { status: 201 });
      } catch (error) {
        log.error("Failed to exchange standalone SSH credential", {
          serverId: req.params.id,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },
  },

  "/api/ssh-servers/:id/sessions": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      try {
        return Response.json(await sshServerManager.listSessions(req.params.id));
      } catch (error) {
        log.error("Failed to list standalone SSH server sessions", {
          serverId: req.params.id,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },

    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = await parseAndValidate(CreateSshServerSessionRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const session = await sshServerManager.createSession(req.params.id, validation.data);
        return Response.json(session, { status: 201 });
      } catch (error) {
        log.error("Failed to create standalone SSH server session", {
          serverId: req.params.id,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },
  },

  "/api/ssh-servers/:id/chats": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      try {
        const server = await sshServerManager.getServer(req.params.id);
        if (!server) {
          return errorResponse("not_found", "SSH server not found", 404);
        }
        return Response.json(await chatManager.getChatSummariesBySshServer(req.params.id));
      } catch (error) {
        log.error("Failed to list SSH-server chats", {
          serverId: req.params.id,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },

    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = await parseAndValidate(CreateSshServerChatRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const chat = await chatManager.createSshServerChat({
          sshServerId: req.params.id,
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
          serverId: req.params.id,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },
  },

  "/api/ssh-servers/:id/chat-providers": {
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = await parseAndValidate(DiscoverSshServerChatProvidersRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const server = await sshServerManager.getServer(req.params.id);
        if (!server) {
          return errorResponse("not_found", "SSH server not found", 404);
        }
        const password = sshCredentialManager.getPasswordForToken(req.params.id, validation.data.credentialToken);
        const { executor } = await sshServerManager.getCommandExecutor(req.params.id, password);
        const [copilot, opencode, codex, claude] = await Promise.all([
          executor.exec("sh", ["-lc", buildProviderAvailabilityShellCheck("copilot")]),
          executor.exec("sh", ["-lc", buildProviderAvailabilityShellCheck("opencode")]),
          executor.exec("sh", ["-lc", buildProviderAvailabilityShellCheck("codex")]),
          executor.exec("sh", ["-lc", buildProviderAvailabilityShellCheck("claude")]),
        ]);
        return Response.json({
          providers: [
            { providerID: "copilot", available: copilot.success },
            { providerID: "opencode", available: opencode.success },
            { providerID: "codex", available: codex.success },
            { providerID: "claude", available: claude.success },
          ],
        });
      } catch (error) {
        log.error("Failed to discover SSH-server chat providers", {
          serverId: req.params.id,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },
  },

  "/api/ssh-servers/:id/chat-models": {
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = await parseAndValidate(DiscoverSshServerChatModelsRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const server = await sshServerManager.getServer(req.params.id);
        if (!server) {
          return errorResponse("not_found", "SSH server not found", 404);
        }
        const password = sshCredentialManager.getPasswordForToken(req.params.id, validation.data.credentialToken);
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
          `ssh-server:${req.params.id}:${validation.data.providerID}`,
          validation.data.directory,
          settings,
        );
        return Response.json(models.filter((model) => model.providerID === validation.data.providerID));
      } catch (error) {
        log.error("Failed to discover SSH-server chat models", {
          serverId: req.params.id,
          providerID: validation.success ? validation.data.providerID : undefined,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },
  },

  "/api/ssh-servers/:id/prerequisites/check": {
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = await parseAndValidate(CheckSshServerPrerequisitesRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        return Response.json(await sshServerManager.checkPrerequisites(req.params.id, validation.data));
      } catch (error) {
        log.error("Failed to check standalone SSH server prerequisites", {
          serverId: req.params.id,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },
  },

  "/api/ssh-servers/:id/devbox/templates": {
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = await parseAndValidate(GetDevboxTemplatesRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        return Response.json(await sshServerManager.listDevboxTemplates(req.params.id, validation.data));
      } catch (error) {
        log.error("Failed to list standalone SSH server devbox templates", {
          serverId: req.params.id,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },
  },

  "/api/ssh-server-sessions/:id": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      try {
        const session = await sshServerManager.getSession(req.params.id);
        if (!session) {
          return errorResponse("not_found", "SSH server session not found", 404);
        }
        return Response.json(session);
      } catch (error) {
        log.error("Failed to fetch standalone SSH server session", {
          sshServerSessionId: req.params.id,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },

    async PATCH(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = await parseAndValidate(UpdateSshSessionRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        return Response.json(await sshServerManager.updateSession(req.params.id, validation.data));
      } catch (error) {
        log.error("Failed to update standalone SSH server session", {
          sshServerSessionId: req.params.id,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },

    async DELETE(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = await parseAndValidate(DeleteSshServerSessionRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const deleted = await sshServerManager.deleteSession(req.params.id, validation.data);
        if (!deleted) {
          return errorResponse("not_found", "SSH server session not found", 404);
        }
        return Response.json({ success: true });
      } catch (error) {
        log.error("Failed to delete standalone SSH server session", {
          sshServerSessionId: req.params.id,
          error: String(error),
        });
        return mapSshServerError(error);
      }
    },
  },
};
