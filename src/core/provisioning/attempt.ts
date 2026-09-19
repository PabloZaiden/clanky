import type {
  ProvisioningCleanupError,
  ProvisioningJobError,
  ProvisioningJobStatus,
  ProvisioningStep,
} from "@/shared";
import { createLogger } from "@pablozaiden/webapp/server";
import { updateProvisioningJob } from "../../persistence/provisioning-jobs";
import { emitJobCancelled, emitJobCompleted, emitJobFailed } from "./job-events";
import { appendSystemLog, persistProvisioningState, persistStep } from "./job-logger";
import { buildError } from "./devbox-utils";
import { ProvisioningCancelledError, ProvisioningFailedError } from "./errors";
import { isProvisioningJobTerminal } from "@/shared";
import type { ProvisioningJobRecord } from "./types";
import { assertValidProvisioningTransition } from "./state-machine";

const log = createLogger("core:provisioning-attempt");

export interface ProvisioningResourceHandle {
  commit(): void;
  disarm(): void;
}

interface ProvisioningCleanupAction {
  resource: string;
  cleanup: () => Promise<void> | void;
  committed: boolean;
  completed: boolean;
}

export interface ProvisioningAttemptOptions {
  record: ProvisioningJobRecord;
  maxLogEntries: number;
}

export class ProvisioningAttempt {
  readonly record: ProvisioningJobRecord;
  private readonly maxLogEntries: number;
  private readonly cleanupActions: ProvisioningCleanupAction[] = [];
  private finalizationPromise: Promise<void> | undefined;

  constructor(options: ProvisioningAttemptOptions) {
    this.record = options.record;
    this.maxLogEntries = options.maxLogEntries;
  }

  get signal(): AbortSignal {
    return this.record.abortController.signal;
  }

  step(step: ProvisioningStep, message?: string): void {
    if (this.isFinalized()) {
      return;
    }
    persistStep(this.record, this.maxLogEntries, step, message);
  }

  update(updates: Partial<ProvisioningJobRecord["job"]["state"]>): void {
    if (this.isFinalized()) {
      return;
    }
    persistProvisioningState(this.record, updates, "ProvisioningAttempt.update");
  }

  registerCleanup(
    resource: string,
    cleanup: () => Promise<void> | void,
  ): ProvisioningResourceHandle {
    const action: ProvisioningCleanupAction = {
      resource,
      cleanup,
      committed: false,
      completed: false,
    };
    this.cleanupActions.push(action);
    return {
      commit: () => {
        action.committed = true;
      },
      disarm: () => {
        action.completed = true;
      },
    };
  }

  async complete(message?: string, step?: ProvisioningStep): Promise<void> {
    if (this.isFinalized()) {
      return;
    }
    if (this.finalizationPromise) {
      return await this.finalizationPromise;
    }
    this.finalizationPromise = this.finishCompleted(message, step);
    return await this.finalizationPromise;
  }

  async fail(
    error: unknown,
    fallbackCode: string,
    fallbackStep: ProvisioningStep,
  ): Promise<void> {
    if (this.isFinalized()) {
      return;
    }
    if (this.finalizationPromise) {
      return await this.finalizationPromise;
    }
    this.finalizationPromise = this.finishFailed(error, fallbackCode, fallbackStep);
    return await this.finalizationPromise;
  }

  private async finishCompleted(
    message: string | undefined,
    step: ProvisioningStep | undefined,
  ): Promise<void> {
    if (this.isFinalized()) {
      return;
    }
    if (step) {
      this.step(step);
    }
    const cleanupErrors = await this.runCleanup();
    this.updateTerminalState("completed", undefined, cleanupErrors);
    if (message) {
      appendSystemLog(this.record, this.maxLogEntries, message, step);
    }
    emitJobCompleted(this.record.job);
  }

  private async finishFailed(
    error: unknown,
    fallbackCode: string,
    fallbackStep: ProvisioningStep,
  ): Promise<void> {
    if (this.isFinalized()) {
      return;
    }
    const cancelled =
      error instanceof ProvisioningCancelledError
      || this.signal.aborted;
    const failure = cancelled
      ? buildError(
          "cancelled",
          this.record.job.state.currentStep ?? fallbackStep,
          "Provisioning job was cancelled",
        )
      : error instanceof ProvisioningFailedError
        ? buildError(error.code, error.step, error.message)
        : buildError(
            fallbackCode,
            this.record.job.state.currentStep ?? fallbackStep,
            error instanceof Error ? error.message : String(error),
          );
    const cleanupErrors = await this.runCleanup();
    this.updateTerminalState(
      cancelled ? "cancelled" : "failed",
      failure,
      cleanupErrors,
    );
    appendSystemLog(this.record, this.maxLogEntries, failure.message, failure.step);
    if (cancelled) {
      emitJobCancelled(this.record.job);
    } else {
      emitJobFailed(this.record.job, failure);
    }
  }

  private async runCleanup(): Promise<ProvisioningCleanupError[]> {
    const cleanupErrors: ProvisioningCleanupError[] = [];
    for (const action of [...this.cleanupActions].reverse()) {
      if (action.committed || action.completed) {
        continue;
      }
      action.completed = true;
      try {
        await action.cleanup();
      } catch (error) {
        const diagnostic: ProvisioningCleanupError = {
          resource: action.resource,
          message: error instanceof Error ? error.message : String(error),
        };
        cleanupErrors.push(diagnostic);
        try {
          appendSystemLog(
            this.record,
            this.maxLogEntries,
            `Cleanup failed for ${action.resource}: ${diagnostic.message}`,
            this.record.job.state.currentStep,
          );
        } catch (logError) {
          log.error("Failed to persist provisioning cleanup diagnostic", {
            provisioningJobId: this.record.job.config.id,
            resource: action.resource,
            error: String(logError),
          });
        }
      }
    }
    return cleanupErrors;
  }

  private updateTerminalState(
    status: Extract<ProvisioningJobStatus, "completed" | "failed" | "cancelled">,
    error: ProvisioningJobError | undefined,
    cleanupErrors: ProvisioningCleanupError[],
  ): void {
    const now = new Date().toISOString();
    const nextState = {
      ...this.record.job.state,
      status,
      ...(error ? { error } : { error: undefined }),
      ...(cleanupErrors.length > 0 ? { cleanupErrors } : { cleanupErrors: undefined }),
      completedAt: now,
      updatedAt: now,
    };
    if (isProvisioningJobTerminal(this.record.job.state.status)) {
      return;
    }
    assertValidProvisioningTransition(
      this.record.job.state.status,
      status,
      "ProvisioningAttempt.updateTerminalState",
    );
    this.record.job.state = nextState;
    updateProvisioningJob(this.record.owner.id, this.record.job);
  }

  private isFinalized(): boolean {
    return isProvisioningJobTerminal(this.record.job.state.status);
  }
}
