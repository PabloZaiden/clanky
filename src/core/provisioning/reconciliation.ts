import { createLogger } from "@pablozaiden/webapp/server";
import {
  listProvisioningJobs,
  markProvisioningJobsInterrupted,
} from "../../persistence/provisioning-jobs";
import { meshManager } from "../mesh-manager";
import { workspaceManager } from "../workspace-manager";

const log = createLogger("core:provisioning-reconciliation");

export class ProvisioningReconciler {
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
    const enrollmentId = job.config.workerEnrollmentId;
    if (!enrollmentId) {
      // workspaceWorkerEnrollmentId identifies an existing enrollment used as
      // the provisioning host; it is not owned by the abandoned attempt.
      return;
    }

    let workspaceDeleted = false;
    if (job.state.workspaceId && job.state.workspaceAction !== "reused") {
      try {
        const deletion = await workspaceManager.deleteWorkspace(job.state.workspaceId);
        workspaceDeleted = deletion.success;
        if (!deletion.success) {
          log.warn("Failed to remove workspace from interrupted dedicated-worker provisioning", {
            provisioningJobId: job.config.id,
            workspaceId: job.state.workspaceId,
            error: String(deletion.error),
          });
        }
      } catch (error) {
        log.warn("Failed to remove workspace from interrupted dedicated-worker provisioning", {
          provisioningJobId: job.config.id,
          workspaceId: job.state.workspaceId,
          error: String(error),
        });
      }
    }
    if (!workspaceDeleted) {
      try {
        const workspaceStillExists = job.state.workspaceId
          ? await workspaceManager.getWorkspace(job.state.workspaceId) !== null
          : false;
        await meshManager.cleanupDedicatedWorker(userId, enrollmentId, {
          preserveRegistration: workspaceStillExists,
        });
      } catch (error) {
        log.error("Failed to clean up dedicated worker after server restart", {
          provisioningJobId: job.config.id,
          enrollmentId,
          error: String(error),
        });
      }
    }
  }
}
