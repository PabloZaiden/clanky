import { createLogger } from "@pablozaiden/webapp/server";
import {
  createProvisioningJob,
  dismissProvisioningJob,
  listProvisioningJobs,
} from "../../persistence/provisioning-jobs";
import type {
  ProvisioningJob,
  ProvisioningJobSnapshot,
  ProvisioningLogEntry,
} from "@/shared";
import { DEFAULT_MAX_LOG_ENTRIES } from "./constants";
import { buildError } from "./devbox-utils";
import { ProvisioningCancelledError, ProvisioningFailedError } from "./errors";
import { ProvisioningAttempt } from "./attempt";
import { emitJobCancelled, emitJobDismissed, emitJobStarted } from "./job-events";
import { appendSystemLog, persistProvisioningState } from "./job-logger";
import type { ProvisioningJobRecord, StartProvisioningJobOptions } from "./types";
import { requireCurrentUser, requireCurrentUserId, runWithCurrentUser } from "../user-context";
import {
  claimProvisioningTarget,
  getProvisioningTargetKey,
  normalizeOptionalValue,
  releaseProvisioningTargetClaim,
  resolveProvisioningTarget,
} from "./target-resolver";
import { ProvisioningRemoteExecutor } from "./remote-executor";
import { ProvisioningReconciler } from "./reconciliation";
import { ProvisioningSnapshotProjector } from "./snapshot-projector";
import { ProvisioningWorkerLifecycle } from "./worker-lifecycle";
import { ProvisioningWorkflows } from "./workflows";

const log = createLogger("core:provisioning-manager");

export class ProvisioningManager {
  private readonly jobs = new Map<string, ProvisioningJobRecord>();
  private readonly workerLifecycle: ProvisioningWorkerLifecycle;
  private readonly remoteExecutor: ProvisioningRemoteExecutor;
  private readonly reconciler: ProvisioningReconciler;
  private readonly snapshotProjector: ProvisioningSnapshotProjector;
  private readonly workflows: ProvisioningWorkflows;

  constructor(
    private readonly maxLogEntries: number = DEFAULT_MAX_LOG_ENTRIES,
  ) {
    this.workerLifecycle = new ProvisioningWorkerLifecycle(maxLogEntries);
    this.remoteExecutor = new ProvisioningRemoteExecutor(maxLogEntries);
    this.reconciler = new ProvisioningReconciler(
      this.remoteExecutor,
      this.workerLifecycle,
    );
    this.snapshotProjector = new ProvisioningSnapshotProjector(maxLogEntries);
    this.workflows = new ProvisioningWorkflows(
      maxLogEntries,
      this.remoteExecutor,
      this.workerLifecycle,
    );
  }

  async startJob(options: StartProvisioningJobOptions): Promise<ProvisioningJobSnapshot> {
    const owner = requireCurrentUser();
    const jobId = crypto.randomUUID();
    const target = await resolveProvisioningTarget(
      owner.id,
      options,
      jobId,
    );
    const {
      mode,
      transport,
      executionHostBinding,
      existingWorkerEnrollmentId,
      workerEnrollmentRoute,
      workerHostAddress,
      workspaceWorkerEnrollmentId,
    } = target;
    const now = new Date().toISOString();
    const record: ProvisioningJobRecord = {
      job: {
        config: {
          id: jobId,
          name: options.name.trim(),
          executionHostBinding,
          transport,
          ...(options.workspaceWorkerEnrollmentId
            ? { workspaceWorkerEnrollmentId: options.workspaceWorkerEnrollmentId }
            : {}),
          ...(existingWorkerEnrollmentId
            ? { workerEnrollmentId: existingWorkerEnrollmentId }
            : {}),
          ...(workerEnrollmentRoute ? { workerEnrollmentRoute } : {}),
          ...(workerHostAddress ? { workerHostAddress } : {}),
          ...(workerHostAddress && options.workerHostAddressManual
            ? { workerHostAddressManual: true }
            : {}),
          repoUrl: normalizeOptionalValue(options.repoUrl),
          basePath: options.basePath.trim(),
          devcontainerSubpath: normalizeOptionalValue(options.devcontainerSubpath),
          devboxTemplate: normalizeOptionalValue(options.devboxTemplate),
          githubUser: normalizeOptionalValue(options.githubUser),
          provider: options.provider,
          mode,
          createNewRepository: options.createNewRepository === true,
          targetDirectory: normalizeOptionalValue(options.targetDirectory),
          workspaceId: normalizeOptionalValue(options.workspaceId),
          createdAt: now,
        },
        state: {
          status: "pending",
          updatedAt: now,
        },
      },
      logs: [],
      abortController: new AbortController(),
      owner,
      runnerActive: true,
      secretValues: options.password?.trim() ? [options.password.trim()] : [],
      targetOwnership: target.ownership,
    };
    record.attempt = new ProvisioningAttempt({
      record,
      maxLogEntries: this.maxLogEntries,
    });

    const targetKey = getProvisioningTargetKey(record.job.config);
    if (targetKey && this.hasActiveTarget(owner.id, targetKey)) {
      throw new ProvisioningFailedError(
        "provisioning_target_busy",
        "verify_devbox",
        "Another provisioning job is already running for this target",
      );
    }

    if (workspaceWorkerEnrollmentId) {
      record.job.config.executionHostBinding = claimProvisioningTarget(
        owner.id,
        target,
        jobId,
      );
      record.workspaceWorkerEnrollmentCleanup = record.attempt.registerCleanup(
        `workspace worker enrollment claim ${workspaceWorkerEnrollmentId}`,
        () => {
          releaseProvisioningTargetClaim(
            owner.id,
            workspaceWorkerEnrollmentId,
            jobId,
          );
        },
      );
    }

    try {
      this.jobs.set(jobId, record);
      createProvisioningJob(owner.id, record.job);
    } catch (error) {
      this.jobs.delete(jobId);
      if (workspaceWorkerEnrollmentId) {
        try {
          releaseProvisioningTargetClaim(owner.id, workspaceWorkerEnrollmentId, jobId);
        } catch (cleanupError) {
          log.error("Failed to release workspace worker enrollment after job creation failed", {
            provisioningJobId: jobId,
            enrollmentId: workspaceWorkerEnrollmentId,
            error: String(cleanupError),
          });
        }
      }
      throw error;
    }
    emitJobStarted(record.job);

    const run = mode === "arise"
      ? () => this.workflows.runServerArise(record, options.password)
      : mode === "rebuild" || mode === "restart"
        ? () => this.workflows.runExistingWorkspace(record, options.password, mode)
        : () => this.workflows.runProvision(record, options.password);
    void runWithCurrentUser(owner, run)
      .catch(async (error) => {
        try {
          await record.attempt?.fail(
            error,
            mode === "arise"
              ? "arise_failed"
              : mode === "restart"
                ? "restart_failed"
                : mode === "rebuild"
                  ? "rebuild_failed"
                  : "provisioning_failed",
            record.job.state.currentStep ?? "verify_devbox",
          );
        } catch (finalizationError) {
          log.error("Failed to finalize crashed provisioning job", {
            provisioningJobId: record.job.config.id,
            mode,
            error: String(finalizationError),
          });
        }
        log.error("Provisioning job crashed unexpectedly", {
          provisioningJobId: record.job.config.id,
          mode,
          error: String(error),
        });
      })
      .finally(() => {
        record.runnerActive = false;
      });

    return await this.getSnapshotOrThrow(jobId);
  }

  async getJobSnapshot(jobId: string): Promise<ProvisioningJobSnapshot | null> {
    const record = this.getOrLoadRecord(jobId);
    if (!record) {
      return null;
    }
    return await this.snapshotProjector.project(record);
  }

  getJobLogs(jobId: string): ProvisioningLogEntry[] | null {
    const record = this.getOrLoadRecord(jobId);
    return record ? [...record.logs] : null;
  }

  listJobs(): ProvisioningJob[] {
    const ownerId = requireCurrentUserId();
    const jobs = new Map(listProvisioningJobs(ownerId).map((job) => [job.config.id, job]));
    for (const record of this.jobs.values()) {
      if (record.owner.id === ownerId) {
        jobs.set(record.job.config.id, structuredClone(record.job));
      }
    }
    return [...jobs.values()].sort((left, right) =>
      right.state.updatedAt.localeCompare(left.state.updatedAt)
      || right.config.createdAt.localeCompare(left.config.createdAt));
  }

  async cancelJob(jobId: string): Promise<ProvisioningJobSnapshot | null> {
    const record = this.getOrLoadRecord(jobId);
    if (!record) {
      return null;
    }

    if (record.job.state.status === "running" || record.job.state.status === "pending") {
      record.abortController.abort();
      if (record.runnerActive) {
        appendSystemLog(record, this.maxLogEntries, "Cancellation requested", record.job.state.currentStep);
      } else {
        if (record.attempt) {
          await record.attempt.fail(
            new ProvisioningCancelledError("Provisioning job was cancelled"),
            "cancelled",
            record.job.state.currentStep ?? "verify_devbox",
          );
        } else {
          const completedAt = new Date().toISOString();
          const failure = buildError(
            "cancelled",
            record.job.state.currentStep ?? "verify_devbox",
            "Provisioning job was cancelled",
          );
          this.updateState(record, {
            status: "cancelled",
            error: failure,
            completedAt,
          });
          appendSystemLog(record, this.maxLogEntries, failure.message, failure.step);
          emitJobCancelled(record.job);
        }
      }
    }

    return await this.snapshotProjector.project(record);
  }

  async dismissJob(jobId: string): Promise<boolean | null> {
    const record = this.getOrLoadRecord(jobId);
    if (!record) {
      return null;
    }
    const status = record.job.state.status;
    if (record.runnerActive || status === "pending" || status === "running") {
      throw new ProvisioningFailedError(
        "job_not_terminal",
        record.job.state.currentStep ?? "verify_devbox",
        "Provisioning is still finalizing and cannot be dismissed yet",
      );
    }

    const deleted = dismissProvisioningJob(record.owner.id, jobId);
    if (!deleted) {
      return false;
    }
    this.jobs.delete(jobId);
    emitJobDismissed(jobId);
    return true;
  }

  reconcileStartupState(): number {
    return this.reconciler.reconcileStartupState(requireCurrentUserId());
  }

  async reconcileDedicatedWorkerStartupState(): Promise<void> {
    await this.reconciler.reconcileDedicatedWorkerStartupState(requireCurrentUserId());
  }

  resetForTesting(): void {
    for (const record of this.jobs.values()) {
      record.abortController.abort();
    }
    this.jobs.clear();
  }

  private async getSnapshotOrThrow(jobId: string): Promise<ProvisioningJobSnapshot> {
    const snapshot = await this.getJobSnapshot(jobId);
    if (!snapshot) {
      throw new Error(`Provisioning job not found: ${jobId}`);
    }
    return snapshot;
  }

  private getOrLoadRecord(jobId: string): ProvisioningJobRecord | null {
    const owner = requireCurrentUser();
    const activeRecord = this.jobs.get(jobId);
    if (activeRecord) {
      return activeRecord.owner.id === owner.id ? activeRecord : null;
    }

    const record = this.snapshotProjector.hydrateRecord(owner, jobId);
    if (!record) {
      return null;
    }
    this.jobs.set(jobId, record);
    return record;
  }

  private hasActiveTarget(ownerId: string, targetKey: string): boolean {
    for (const record of this.jobs.values()) {
      if (
        record.owner.id === ownerId
        && (record.job.state.status === "pending" || record.job.state.status === "running")
        && getProvisioningTargetKey(record.job.config) === targetKey
      ) {
        return true;
      }
    }

    return listProvisioningJobs(ownerId).some((job) =>
      (job.state.status === "pending" || job.state.status === "running")
      && getProvisioningTargetKey(job.config) === targetKey);
  }

  private updateState(
    record: ProvisioningJobRecord,
    updates: Partial<ProvisioningJob["state"]>,
  ): void {
    if (record.attempt) {
      record.attempt.update(updates);
      return;
    }
    persistProvisioningState(record, updates, "ProvisioningManager.updateState");
  }

}

export const provisioningManager = new ProvisioningManager();
