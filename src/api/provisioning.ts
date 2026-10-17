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
    policy: "provisioning",
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
    operations: {
      GET: {
        description: "List public provisioning job summaries.",
        requestSchema: undefined,
        querySchema: SensitiveQuerySchema,
        automation: { policy: "read", hiddenQuery: ["sensitive"] },
      },
      POST: {
        description: "Start provisioning, rebuilding, or restarting on an explicitly selected host.",
        requestSchema: CreateProvisioningJobRequestSchema,
        querySchema: SensitiveQuerySchema,
        automation: {
          policy: "confirm",
          reason: "May create repositories, replace containers, or restart execution hosts.",
          hiddenInputs: ["credentialToken"],
          hiddenQuery: ["sensitive"],
          completion: "admission",
          credential: {
            kind: "ssh",
            hostInput: "executionHost",
            input: "credentialToken",
          },
        },
      },
    },
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
          ...(validation.data.workerEnrollmentRoute
            ? { workerEnrollmentRoute: validation.data.workerEnrollmentRoute }
            : {}),
          ...(validation.data.workerRelayName
            ? { workerRelayName: validation.data.workerRelayName }
            : {}),
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
          adapter: validation.data.adapter,
          mode: validation.data.mode,
          createNewRepository: validation.data.createNewRepository,
          targetDirectory: validation.data.targetDirectory ?? undefined,
          workspaceId: validation.data.workspaceId ?? undefined,
          ...(validation.data.useClankyPrerelease
            ? { useClankyPrerelease: true }
            : {}),
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
    description: "Dismiss a terminal provisioning job and its retained logs.",
    operations: {
      POST: { requestSchema: undefined, querySchema: undefined, automation: { policy: "confirm", reason: "Deletes the retained job record and logs." } },
    },
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
    operations: {
      GET: {
        description: "Read public provisioning job progress.",
        requestSchema: undefined,
        querySchema: SensitiveQuerySchema,
        automation: { policy: "read", hiddenQuery: ["sensitive"] },
      },
      DELETE: {
        description: "Cancel a provisioning job.",
        requestSchema: undefined,
        querySchema: undefined,
        automation: { policy: "confirm", reason: "Interrupts provisioning and may leave a partially prepared target.", completion: "admission" },
      },
    },
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
    operations: {
      GET: { requestSchema: undefined, querySchema: undefined, automation: { policy: "read" } },
    },
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
