import type { ProvisioningCleanupError } from "@/shared";
import { createLogger } from "@pablozaiden/webapp/server";
import {
  appendProvisioningJobLog,
  listProvisioningJobs,
  loadProvisioningJob,
  markProvisioningJobsInterrupted,
  updateProvisioningJob,
} from "../../persistence/provisioning-jobs";
import { meshManager } from "../mesh-manager";
import { workspaceManager } from "../workspace-manager";
import { ProvisioningRemoteExecutor } from "./remote-executor";
import { releaseProvisioningTargetClaim } from "./target-resolver";
import { ProvisioningWorkerLifecycle } from "./worker-lifecycle";

const log = createLogger("core:provisioning-reconciliation");

export class ProvisioningReconciler {
  constructor(
    private readonly remoteExecutor: ProvisioningRemoteExecutor,
    private readonly workerLifecycle: ProvisioningWorkerLifecycle,
  ) {}

  reconcileStartupState(userId: string): number {
    return markProvisioningJobsInterrupted(userId);
  }

  async reconcileDedicatedWorkerStartupState(userId: string): Promise<void> {
    const interruptedJobs = listProvisioningJobs(userId).filter(
      (job) =>
        (job.state.status === "pending" || job.state.status === "running")
        && (job.config.mode ?? "provision") === "provision"
        && (job.config.workspaceWorkerEnrollmentId || job.config.workerEnrollmentId),
    );
    this.reconcileStartupState(userId);

    for (const job of interruptedJobs) {
      await this.reconcileDedicatedWorkerJob(userId, job);
    }
  }

  private async reconcileDedicatedWorkerJob(
    userId: string,
    job: ReturnType<typeof listProvisioningJobs>[number],
  ): Promise<void> {
    const claimedEnrollmentId = job.config.workspaceWorkerEnrollmentId;
    const createdEnrollmentId = job.config.workerEnrollmentId;
    if (!claimedEnrollmentId && !createdEnrollmentId) {
      return;
    }
    const cleanupErrors: ProvisioningCleanupError[] = [];
    if (createdEnrollmentId) {
      const targetDirectory = job.state.targetDirectory ?? job.config.targetDirectory;
      if (targetDirectory) {
        try {
          const executor = await this.remoteExecutor.acquireForRecovery(
            job,
            userId,
            targetDirectory,
          );
          await this.workerLifecycle.cleanupWorkerProcess(
            executor,
            targetDirectory,
            job.state.resolvedDirectory,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          cleanupErrors.push({
            resource: `workspace worker process for enrollment ${createdEnrollmentId}`,
            message,
          });
          log.error("Failed to clean up worker process after server restart", {
            provisioningJobId: job.config.id,
            enrollmentId: createdEnrollmentId,
            error: message,
          });
        }
      } else {
        const message = "The interrupted provisioning job has no target directory.";
        cleanupErrors.push({
          resource: `workspace worker process for enrollment ${createdEnrollmentId}`,
          message,
        });
        log.error("Unable to clean up worker process after server restart", {
          provisioningJobId: job.config.id,
          enrollmentId: createdEnrollmentId,
          error: message,
        });
      }
    }
    if (job.state.workspaceId && job.state.workspaceAction !== "reused") {
      try {
        const deletion = await workspaceManager.deleteWorkspace(job.state.workspaceId);
        if (!deletion.success) {
          const error = String(deletion.error);
          cleanupErrors.push({
            resource: `workspace ${job.state.workspaceId}`,
            message: error,
          });
          log.warn("Failed to remove workspace from interrupted dedicated-worker provisioning", {
            provisioningJobId: job.config.id,
            workspaceId: job.state.workspaceId,
            error,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        cleanupErrors.push({
          resource: `workspace ${job.state.workspaceId}`,
          message,
        });
        log.warn("Failed to remove workspace from interrupted dedicated-worker provisioning", {
          provisioningJobId: job.config.id,
          workspaceId: job.state.workspaceId,
          error: message,
        });
      }
    }
    if (claimedEnrollmentId) {
      try {
        releaseProvisioningTargetClaim(
          userId,
          claimedEnrollmentId,
          job.config.id,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        cleanupErrors.push({
          resource: `workspace worker enrollment claim ${claimedEnrollmentId}`,
          message,
        });
        log.error("Failed to release workspace worker claim after server restart", {
          provisioningJobId: job.config.id,
          enrollmentId: claimedEnrollmentId,
          error: message,
        });
      }
    }
    if (createdEnrollmentId) {
      try {
        const workspaceStillExists = job.state.workspaceId
          ? await workspaceManager.getWorkspace(job.state.workspaceId) !== null
          : false;
        await meshManager.cleanupDedicatedWorker(userId, createdEnrollmentId, {
          preserveRegistration: workspaceStillExists,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        cleanupErrors.push({
          resource: `workspace worker enrollment ${createdEnrollmentId}`,
          message,
        });
        log.error("Failed to clean up dedicated worker after server restart", {
          provisioningJobId: job.config.id,
          enrollmentId: createdEnrollmentId,
          error: message,
        });
      }
    }
    this.persistCleanupErrors(userId, job.config.id, cleanupErrors);
  }

  private persistCleanupErrors(
    userId: string,
    jobId: string,
    cleanupErrors: ProvisioningCleanupError[],
  ): void {
    if (cleanupErrors.length === 0) {
      return;
    }
    const persisted = loadProvisioningJob(userId, jobId);
    if (!persisted) {
      log.error("Unable to persist provisioning cleanup diagnostics", {
        provisioningJobId: jobId,
        userId,
        error: "Provisioning job was not found after startup reconciliation",
      });
      return;
    }
    const now = new Date().toISOString();
    try {
      updateProvisioningJob(userId, {
        ...persisted.job,
        state: {
          ...persisted.job.state,
          cleanupErrors: [
            ...(persisted.job.state.cleanupErrors ?? []),
            ...cleanupErrors,
          ],
          updatedAt: now,
        },
      });
    } catch (error) {
      log.error("Unable to persist provisioning cleanup diagnostics", {
        provisioningJobId: jobId,
        userId,
        error: String(error),
      });
      return;
    }
    for (const cleanupError of cleanupErrors) {
      try {
        appendProvisioningJobLog(userId, jobId, {
          id: crypto.randomUUID(),
          source: "system",
          text: `Cleanup failed for ${cleanupError.resource}: ${cleanupError.message}`,
          timestamp: now,
          ...(persisted.job.state.currentStep
            ? { step: persisted.job.state.currentStep }
            : {}),
        });
      } catch (error) {
        log.error("Unable to persist provisioning cleanup diagnostic log", {
          provisioningJobId: jobId,
          resource: cleanupError.resource,
          error: String(error),
        });
      }
    }
  }
}
