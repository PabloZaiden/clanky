import { defineRoutes } from "@pablozaiden/webapp/server";
import { provisioningManager } from "../core/provisioning-manager";
import { sshCredentialManager } from "../core/ssh-credential-manager";
import { sshServerManager } from "../core/ssh-server-manager";
import { createLogger } from "@pablozaiden/webapp/server";
import { CreateProvisioningJobRequestSchema } from "@/contracts/schemas";
import { domainErrorResponse, errorResponse, successResponse } from "./helpers";
import { parseAndValidate } from "./validation";
import {
  sanitizeProvisioningJob,
  sanitizeProvisioningSnapshot,
  shouldIncludeSensitiveData,
} from "../lib/sensitive-data";
import { SensitiveQuerySchema } from "./route-schemas";
import { getRegisteredSshServerId } from "@/shared/execution-host";

const log = createLogger("api:provisioning");

function mapProvisioningError(error: unknown): Response {
  return domainErrorResponse(error, {
    mappings: {
      ssh_server_not_found: {
        error: "not_found",
        message: "SSH server not found",
        status: 404,
      },
      invalid_credential_token: {
        status: 400,
      },
      invalid_worker_host_address: {
        status: 400,
      },
      invalid_execution_target: {
        status: 400,
      },
      job_not_terminal: {
        status: 409,
      },
      provisioning_target_busy: {
        status: 409,
      },
      provisioning_cancelled: {
        status: 409,
      },
      workspace_worker_enrollment_not_found: {
        status: 404,
      },
      workspace_worker_enrollment_expired: {
        status: 410,
      },
      workspace_worker_enrollment_claimed: {
        status: 409,
      },
      workspace_worker_already_attached: {
        status: 409,
      },
      workspace_worker_enrollment_unavailable: {
        status: 409,
      },
      workspace_worker_not_connected: {
        status: 409,
      },
      mesh_public_base_url_not_configured: {
        status: 400,
        message: "Configure CLANKY_PUBLIC_BASE_URL before using worker provisioning.",
      },
      execution_host_addresses_unavailable: {
        status: 409,
      },
      execution_host_unavailable: {
        status: 409,
      },
    },
    fallback: {
      error: "provisioning_error",
      message: "Provisioning operation failed",
      status: 500,
    },
  });
}

export const provisioningRoutes = defineRoutes({
  "/api/provisioning-jobs": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Start a remote provisioning job.",
    requestSchema: CreateProvisioningJobRequestSchema,
    querySchema: SensitiveQuerySchema,
    async GET(req: Request): Promise<Response> {
      try {
        const jobs = provisioningManager.listJobs();
        return Response.json({
          jobs: shouldIncludeSensitiveData(req) ? jobs : jobs.map(sanitizeProvisioningJob),
        });
      } catch (error) {
        log.error("Failed to list provisioning jobs", { error: String(error) });
        return mapProvisioningError(error);
      }
    },
    async POST(req: Request, _ctx): Promise<Response> {
      const includeSensitive = shouldIncludeSensitiveData(req);
      const validation = await parseAndValidate(CreateProvisioningJobRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const sshServerId = validation.data.executionHost
          ? getRegisteredSshServerId(validation.data.executionHost)
          : null;
        if (
          validation.data.executionHost?.kind === "ssh"
          && !sshServerId
        ) {
          return errorResponse(
            "invalid_execution_host",
            "Provisioning requires a registered SSH server.",
            400,
          );
        }
        const server = sshServerId
          ? await sshServerManager.getServer(sshServerId)
          : null;
        if (sshServerId && !server) {
          return errorResponse("not_found", "SSH server not found", 404);
        }

        const credentialToken = validation.data.credentialToken?.trim();
        const password = credentialToken && server
          ? sshCredentialManager.getPasswordForToken(server.config.id, credentialToken)
          : undefined;

        const snapshot = await provisioningManager.startJob({
          name: validation.data.name,
          ...(validation.data.executionHost
            ? { executionHost: validation.data.executionHost }
            : {}),
          ...(validation.data.workspaceWorkerEnrollmentId
            ? { workspaceWorkerEnrollmentId: validation.data.workspaceWorkerEnrollmentId }
            : {}),
          transport: validation.data.transport,
          ...(validation.data.workerHostAddress
            ? { workerHostAddress: validation.data.workerHostAddress }
            : {}),
          ...(validation.data.workerHostAddressManual
            ? { workerHostAddressManual: true }
            : {}),
          repoUrl: validation.data.repoUrl || undefined,
          basePath: validation.data.basePath,
          devcontainerSubpath: validation.data.devcontainerSubpath ?? undefined,
          devboxTemplate: validation.data.devboxTemplate ?? undefined,
          githubUser: validation.data.githubUser ?? undefined,
          provider: validation.data.provider,
          mode: validation.data.mode,
          createNewRepository: validation.data.createNewRepository,
          targetDirectory: validation.data.targetDirectory ?? undefined,
          workspaceId: validation.data.workspaceId ?? undefined,
          password,
        });
        return Response.json(
          includeSensitive ? snapshot : sanitizeProvisioningSnapshot(snapshot),
          { status: 201 },
        );
      } catch (error) {
        log.error("Failed to start provisioning job", { error: String(error) });
        return mapProvisioningError(error);
      }
    },
  },

  "/api/provisioning-jobs/:id/dismiss": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Dismiss a completed, failed, cancelled, or interrupted provisioning job.",
    async POST(_req: Request, ctx): Promise<Response> {
      try {
        const dismissed = await provisioningManager.dismissJob(ctx.params["id"]!);
        if (dismissed !== true) {
          return errorResponse("not_found", "Provisioning job not found", 404);
        }
        return successResponse({ dismissed: true });
      } catch (error) {
        log.error("Failed to dismiss provisioning job", {
          provisioningJobId: ctx.params["id"]!,
          error: String(error),
        });
        return mapProvisioningError(error);
      }
    },
  },

  "/api/provisioning-jobs/:id": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read or cancel a remote provisioning job.",
    querySchema: SensitiveQuerySchema,
    async GET(req: Request, ctx): Promise<Response> {
      try {
        const snapshot = await provisioningManager.getJobSnapshot(ctx.params["id"]!);
        if (!snapshot) {
          return errorResponse("not_found", "Provisioning job not found", 404);
        }
        return Response.json(
          shouldIncludeSensitiveData(req) ? snapshot : sanitizeProvisioningSnapshot(snapshot),
        );
      } catch (error) {
        log.error("Failed to fetch provisioning job", {
          provisioningJobId: ctx.params["id"]!,
          error: String(error),
        });
        return mapProvisioningError(error);
      }
    },

    async DELETE(_req: Request, ctx): Promise<Response> {
      try {
        const snapshot = await provisioningManager.cancelJob(ctx.params["id"]!);
        if (!snapshot) {
          return errorResponse("not_found", "Provisioning job not found", 404);
        }
        return successResponse({
          job: snapshot.job,
        });
      } catch (error) {
        log.error("Failed to cancel provisioning job", {
          provisioningJobId: ctx.params["id"]!,
          error: String(error),
        });
        return mapProvisioningError(error);
      }
    },
  },

  "/api/provisioning-jobs/:id/logs": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read logs for a remote provisioning job.",
    async GET(_req: Request, ctx): Promise<Response> {
      try {
        const logs = provisioningManager.getJobLogs(ctx.params["id"]!);
        if (!logs) {
          return errorResponse("not_found", "Provisioning job not found", 404);
        }
        return successResponse({ logs });
      } catch (error) {
        log.error("Failed to fetch provisioning logs", {
          provisioningJobId: ctx.params["id"]!,
          error: String(error),
        });
        return mapProvisioningError(error);
      }
    },
  },
});
