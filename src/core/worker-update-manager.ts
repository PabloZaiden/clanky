import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import { createLogger } from "@pablozaiden/webapp/server";
import type { MeshWorkerRegistration } from "@/shared/mesh";
import type { WorkerUpdateJob, WorkerUpdateJobSnapshot } from "@/shared/worker-update";
import {
  dismissWorkerUpdateJob,
  createWorkerUpdateJob,
  listWorkerUpdateJobs,
  loadWorkerUpdateJob,
  markWorkerUpdateJobsInterrupted,
} from "../persistence/worker-update-jobs";
import { requireCurrentUser, requireCurrentUserId, runWithCurrentUser } from "../context/user-context";
import { meshManager } from "./mesh-manager";
import { isWorkerUpdateJobTerminal } from "@/shared/worker-update";
import { WorkerUpdateJobRunner } from "./worker-update/runner";
import {
  emitWorkerUpdateJobChanged,
  emitWorkerUpdateJobDeleted,
} from "./worker-update/job-events";

const log = createLogger("core:worker-update-manager");

export type WorkerUpdateAdmissionResult =
  | {
      workerNodeId: string;
      workerName: string;
      status: "started";
      jobId: string;
    }
  | {
      workerNodeId: string;
      workerName: string;
      status: "failed";
      error: string;
    };

export interface StartWorkerUpdateJobsResult {
  totalWorkers: number;
  results: WorkerUpdateAdmissionResult[];
}

export type DismissWorkerUpdateJobResult =
  | "dismissed"
  | "not_found"
  | "not_terminal";

export class WorkerUpdateManager {
  private readonly runner = new WorkerUpdateJobRunner();

  reconcileStartupState(): number {
    const interrupted = markWorkerUpdateJobsInterrupted(requireCurrentUserId());
    if (interrupted > 0) {
      log.info(`Reconciled ${interrupted} interrupted worker update jobs`);
    }
    return interrupted;
  }

  async startGlobalWorkerUpdates(): Promise<StartWorkerUpdateJobsResult> {
    const owner = requireCurrentUser();
    const { workers } = await meshManager.getControllerStatus(owner.id);
    const targets = workers.filter(
      (worker) =>
        worker.registrationScope !== "workspace"
        && worker.grantStatus === "active",
    );
    return {
      totalWorkers: targets.length,
      results: targets.map((worker) => this.admitJob(owner, worker)),
    };
  }

  listJobs(): WorkerUpdateJob[] {
    return listWorkerUpdateJobs(requireCurrentUserId());
  }

  getJobSnapshot(jobId: string): WorkerUpdateJobSnapshot | null {
    return loadWorkerUpdateJob(requireCurrentUserId(), jobId);
  }

  dismissJob(jobId: string): DismissWorkerUpdateJobResult {
    const userId = requireCurrentUserId();
    const snapshot = loadWorkerUpdateJob(userId, jobId);
    if (!snapshot) {
      return "not_found";
    }
    if (!isWorkerUpdateJobTerminal(snapshot.job.state.status)) {
      return "not_terminal";
    }
    if (!dismissWorkerUpdateJob(userId, jobId)) {
      return "not_found";
    }
    emitWorkerUpdateJobDeleted(jobId, userId);
    return "dismissed";
  }

  private admitJob(
    owner: CurrentUser,
    worker: MeshWorkerRegistration,
  ): WorkerUpdateAdmissionResult {
    const workerName = worker.workerInstanceName?.trim() || worker.workerNodeId;
    const now = new Date().toISOString();
    const job: WorkerUpdateJob = {
      config: {
        id: crypto.randomUUID(),
        workerNodeId: worker.workerNodeId,
        workerName,
        createdAt: now,
      },
      state: {
        status: "pending",
        currentStep: null,
        steps: {
          update: { status: "pending" },
          restart: { status: "pending" },
        },
        updatedAt: now,
      },
    };
    try {
      createWorkerUpdateJob(owner.id, job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("Failed to admit worker update job", {
        workerNodeId: worker.workerNodeId,
        userId: owner.id,
        error: message,
      });
      return {
        workerNodeId: worker.workerNodeId,
        workerName,
        status: "failed",
        error: message,
      };
    }

    emitWorkerUpdateJobChanged(job, owner.id);
    void runWithCurrentUser(owner, async () => {
      await this.runner.run(owner.id, job, worker);
    }).catch((error) => {
      log.error("Worker update runner rejected unexpectedly", {
        workerNodeId: worker.workerNodeId,
        jobId: job.config.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return {
      workerNodeId: worker.workerNodeId,
      workerName,
      status: "started",
      jobId: job.config.id,
    };
  }
}

export const workerUpdateManager = new WorkerUpdateManager();
