/**
 * API endpoints for standalone SSH server key and credential handoff flows.
 */

import { sshCredentialManager } from "../core/ssh-credential-manager";
import { sshServerManager } from "../core/ssh-server-manager";
import { sshServerKeyManager } from "../core/ssh-server-key-manager";
import { createLogger } from "../core/logger";
import { errorResponse } from "./helpers";
import { parseAndValidate } from "./validation";
import {
  CheckSshServerPrerequisitesRequestSchema,
  CreateSshServerRequestSchema,
  CreateSshServerSessionRequestSchema,
  DeleteSshServerSessionRequestSchema,
  SshCredentialExchangeRequestSchema,
  UpdateSshServerRequestSchema,
  UpdateSshSessionRequestSchema,
} from "../types/schemas";

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
