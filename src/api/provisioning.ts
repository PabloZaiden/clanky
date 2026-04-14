import { provisioningManager } from "../core/provisioning-manager";
import { sshCredentialManager } from "../core/ssh-credential-manager";
import { sshServerManager } from "../core/ssh-server-manager";
import { createLogger } from "../core/logger";
import { CreateProvisioningJobRequestSchema } from "../types/schemas";
import { errorResponse, successResponse } from "./helpers";
import { parseAndValidate } from "./validation";

const log = createLogger("api:provisioning");

function mapProvisioningError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("SSH server not found")) {
    return errorResponse("not_found", message, 404);
  }
  if (message.includes("credential token")) {
    return errorResponse("invalid_credential_token", message, 400);
  }

  return errorResponse("provisioning_error", message, 500);
}

export const provisioningRoutes = {
  "/api/provisioning-jobs": {
    async POST(req: Request): Promise<Response> {
      const validation = await parseAndValidate(CreateProvisioningJobRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const server = await sshServerManager.getServer(validation.data.sshServerId);
        if (!server) {
          return errorResponse("not_found", "SSH server not found", 404);
        }

        const credentialToken = validation.data.credentialToken?.trim();
        const password = credentialToken
          ? sshCredentialManager.getPasswordForToken(server.config.id, credentialToken)
          : undefined;

        const snapshot = await provisioningManager.startJob({
          name: validation.data.name,
          sshServerId: validation.data.sshServerId,
          repoUrl: validation.data.repoUrl,
          basePath: validation.data.basePath,
          devcontainerSubpath: validation.data.devcontainerSubpath ?? undefined,
          provider: validation.data.provider,
          mode: validation.data.mode,
          targetDirectory: validation.data.targetDirectory ?? undefined,
          workspaceId: validation.data.workspaceId ?? undefined,
          password,
        });
        return Response.json(snapshot, { status: 201 });
      } catch (error) {
        log.error("Failed to start provisioning job", { error: String(error) });
        return mapProvisioningError(error);
      }
    },
  },

  "/api/provisioning-jobs/:id": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      try {
        const snapshot = await provisioningManager.getJobSnapshot(req.params.id);
        if (!snapshot) {
          return errorResponse("not_found", "Provisioning job not found", 404);
        }
        return Response.json(snapshot);
      } catch (error) {
        log.error("Failed to fetch provisioning job", {
          provisioningJobId: req.params.id,
          error: String(error),
        });
        return mapProvisioningError(error);
      }
    },

    async DELETE(req: Request & { params: { id: string } }): Promise<Response> {
      try {
        const snapshot = await provisioningManager.cancelJob(req.params.id);
        if (!snapshot) {
          return errorResponse("not_found", "Provisioning job not found", 404);
        }
        return successResponse({
          job: snapshot.job,
        });
      } catch (error) {
        log.error("Failed to cancel provisioning job", {
          provisioningJobId: req.params.id,
          error: String(error),
        });
        return mapProvisioningError(error);
      }
    },
  },

  "/api/provisioning-jobs/:id/logs": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      try {
        const logs = provisioningManager.getJobLogs(req.params.id);
        if (!logs) {
          return errorResponse("not_found", "Provisioning job not found", 404);
        }
        return successResponse({ logs });
      } catch (error) {
        log.error("Failed to fetch provisioning logs", {
          provisioningJobId: req.params.id,
          error: String(error),
        });
        return mapProvisioningError(error);
      }
    },
  },
};
