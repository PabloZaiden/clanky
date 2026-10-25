import { createLogger, defineRoutes } from "@pablozaiden/webapp/server";
import {
  DismissWorkerUpdateJobResponseSchema,
  StartWorkerUpdatesResponseSchema,
  StartWorkerUpdatesRequestSchema,
  WorkerUpdateJobSnapshotSchema,
  WorkerUpdateJobsResponseSchema,
} from "@/contracts/schemas/worker-update";
import { workerUpdateManager } from "../core/worker-update-manager";
import { domainErrorResponse, errorResponse, successResponse } from "./helpers";
import { parseAndValidate } from "./validation";
import { CLANKY_REALTIME_RESOURCES } from "@/shared/realtime";

const log = createLogger("api:worker-update-jobs");

function workerUpdateErrorResponse(error: unknown): Response {
  return domainErrorResponse(error, {
    policy: "mesh",
    fallback: {
      error: "worker_update_operation_failed",
      message: "Worker update operation failed",
      status: 500,
    },
  });
}

export const workerUpdateRoutes = defineRoutes({
  "/api/worker-update-jobs": {
    auth: "owner",
    sameOrigin: "mutations",
    cliPath: "worker-update-jobs",
    description: "Start updates on all active server and automatic workspace Mesh workers or list update jobs.",
    tags: ["mesh", "workers", "worker-updates"],
    operations: {
      GET: {
        description: "List retained Mesh worker update jobs.",
        requestSchema: undefined,
        querySchema: undefined,
        responseSchema: WorkerUpdateJobsResponseSchema,
        automation: { policy: "read" },
      },
      POST: {
        description: "Update active Mesh workers using their defaults or persistently force stable/latest; remember the selected mode and automatic-workspace default.",
        requestSchema: StartWorkerUpdatesRequestSchema,
        querySchema: undefined,
        responseSchema: StartWorkerUpdatesResponseSchema,
        automation: {
          policy: "confirm",
          reason: "Runs clanky update and, only after success, restarts Clanky on every active server and automatic workspace Mesh worker.",
          completion: "admission",
        },
      },
    },
    async GET(_req, ctx): Promise<Response> {
      try {
        return Response.json({ jobs: workerUpdateManager.listJobs() });
      } catch (error) {
        log.error("Failed to list worker update jobs", {
          userId: ctx.requireOwner().id,
          error: String(error),
        });
        return workerUpdateErrorResponse(error);
      }
    },
    async POST(req, ctx): Promise<Response> {
      ctx.server?.timeout(req, 0);
      try {
        const validation = await parseAndValidate(StartWorkerUpdatesRequestSchema, req, {
          allowEmptyBody: true,
          emptyBodyValue: {},
        });
        if (!validation.success) return validation.response;
        const result = await workerUpdateManager.startWorkerUpdates(validation.data.channel);
        ctx.userRealtime.publishChanged(CLANKY_REALTIME_RESOURCES.workerUpdatePreferences);
        log.info("Worker update jobs admitted", {
          userId: ctx.requireOwner().id,
          totalWorkers: result.totalWorkers,
          startedCount: result.results.filter((item) => item.status === "started").length,
          failureCount: result.results.filter((item) => item.status === "failed").length,
        });
        return Response.json({ success: true, ...result }, { status: 202 });
      } catch (error) {
        log.error("Failed to admit worker update jobs", {
          userId: ctx.requireOwner().id,
          error: String(error),
        });
        return workerUpdateErrorResponse(error);
      }
    },
  },

  "/api/worker-update-jobs/:id": {
    auth: "owner",
    sameOrigin: "mutations",
    cliPath: "worker-update-jobs/:id",
    description: "Read a Mesh worker update job and its retained logs.",
    tags: ["mesh", "workers", "worker-updates"],
    operations: {
      GET: {
        description: "Read one Mesh worker update job with progress and logs.",
        requestSchema: undefined,
        querySchema: undefined,
        responseSchema: WorkerUpdateJobSnapshotSchema,
        automation: { policy: "read" },
      },
    },
    async GET(_req, ctx): Promise<Response> {
      try {
        const snapshot = workerUpdateManager.getJobSnapshot(ctx.params["id"]!);
        if (!snapshot) {
          return errorResponse("not_found", "Worker update job not found", 404);
        }
        return Response.json(snapshot);
      } catch (error) {
        log.error("Failed to fetch worker update job", {
          workerUpdateJobId: ctx.params["id"]!,
          userId: ctx.requireOwner().id,
          error: String(error),
        });
        return workerUpdateErrorResponse(error);
      }
    },
  },

  "/api/worker-update-jobs/:id/dismiss": {
    auth: "owner",
    sameOrigin: "mutations",
    cliPath: "worker-update-jobs/:id/dismiss",
    description: "Dismiss a terminal Mesh worker update job and its logs.",
    tags: ["mesh", "workers", "worker-updates"],
    operations: {
      POST: {
        requestSchema: undefined,
        querySchema: undefined,
        responseSchema: DismissWorkerUpdateJobResponseSchema,
        automation: {
          policy: "confirm",
          reason: "Deletes a terminal worker update job and its retained logs.",
        },
      },
    },
    async POST(_req, ctx): Promise<Response> {
      try {
        const result = workerUpdateManager.dismissJob(ctx.params["id"]!);
        if (result === "not_found") {
          return errorResponse("not_found", "Worker update job not found", 404);
        }
        if (result === "not_terminal") {
          return errorResponse(
            "worker_update_job_active",
            "Only terminal worker update jobs can be dismissed.",
            409,
          );
        }
        return successResponse({ dismissed: true });
      } catch (error) {
        log.error("Failed to dismiss worker update job", {
          workerUpdateJobId: ctx.params["id"]!,
          userId: ctx.requireOwner().id,
          error: String(error),
        });
        return workerUpdateErrorResponse(error);
      }
    },
  },
});
