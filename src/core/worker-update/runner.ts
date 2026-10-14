import type { MeshWorkerRegistration } from "@/shared/mesh";
import type {
  WorkerUpdateJob,
  WorkerUpdateJobError,
  WorkerUpdateJobState,
  WorkerUpdateLogEntry,
  WorkerUpdateStep,
} from "@/shared/worker-update";
import { DEFAULT_EXECUTION_AGENT_PROVIDER } from "@/shared/settings";
import { createLogger } from "@pablozaiden/webapp/server";
import { DomainError } from "../../domain/domain-error";
import {
  appendWorkerUpdateJobLog,
  loadWorkerUpdateJob,
  updateWorkerUpdateJob,
} from "../../persistence/worker-update-jobs";
import { getWorkerRegistrationExecutionHostRef } from "../../persistence/mesh";
import { closeCommandExecutor, type CommandExecutor, type CommandResult } from "../command-executor";
import { executionHostService } from "../execution-host-service";
import { emitWorkerUpdateJobChanged } from "./job-events";
import { confirmWorkerRestart, isWorkerRestartConnectionLoss } from "./restart-confirmation";

const log = createLogger("core:worker-update-runner");
const MAX_COMMAND_OUTPUT_BYTES = 128 * 1024;
const MAX_LOG_TEXT_LENGTH = 16 * 1024;

function redactLogText(text: string): string {
  return text
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\b(bearer)\s+\S+/gi, "$1 [REDACTED]")
    .replace(
      /\b(password|token|secret|api[-_ ]?key|authorization)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1$2[REDACTED]",
    )
    .replace(/\b(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[REDACTED]@");
}

function getErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactLogText(message).slice(0, MAX_LOG_TEXT_LENGTH);
}

function toJobError(
  error: unknown,
  step: WorkerUpdateStep,
  fallbackCode: string,
): WorkerUpdateJobError {
  return {
    code: error instanceof DomainError ? error.code : fallbackCode,
    message: getErrorMessage(error),
    step,
  };
}

export class WorkerUpdateJobRunner {
  async run(
    userId: string,
    initialJob: WorkerUpdateJob,
    worker: MeshWorkerRegistration,
  ): Promise<void> {
    let job = initialJob;
    let executor: CommandExecutor | undefined;
    let commandInFlight: WorkerUpdateStep | null = null;

    try {
      job = this.beginJob(userId, job);
      this.appendLog(userId, job, "system", "Starting clanky update.", "update");
      executor = await this.acquireExecutor(userId, job, worker);

      commandInFlight = "update";
      const updateResult = await executor.exec(
        "clanky",
        ["update"],
        this.commandOptions(userId, job, "update"),
      );
      if (!updateResult.success) {
        const error = new DomainError(
          "worker_update_command_failed",
          `clanky update exited with code ${String(updateResult.exitCode)}.`,
        );
        job = this.failStep(userId, job, "update", error, updateResult.exitCode);
        commandInFlight = null;
        return;
      }
      job = this.succeedStep(userId, job, "update", updateResult.exitCode);
      commandInFlight = null;
      this.appendLog(
        userId,
        job,
        "system",
        `clanky update succeeded with exit code ${String(updateResult.exitCode)}.`,
        "update",
      );

      await this.restartWorker({ userId, initialJob: job, worker, executor });
    } catch (error) {
      this.reconcileUnexpectedFailure(userId, job, commandInFlight, error);
    } finally {
      if (executor) {
        try {
          closeCommandExecutor(executor);
        } catch (error) {
          log.warn("Failed to close worker update command executor", {
            workerNodeId: worker.workerNodeId,
            jobId: initialJob.config.id,
            error: String(error),
          });
        }
      }
    }
  }

  private async restartWorker({
    userId,
    initialJob,
    worker,
    executor,
  }: {
    userId: string;
    initialJob: WorkerUpdateJob;
    worker: MeshWorkerRegistration;
    executor: CommandExecutor;
  }): Promise<void> {
    let job = this.beginStep(userId, initialJob, "restart");
    this.appendLog(userId, job, "system", "Starting clanky worker service restart.", "restart");
    let result: CommandResult | undefined;
    try {
      result = await executor.exec(
        "clanky",
        ["worker", "service", "restart"],
        {
          ...this.commandOptions(userId, job, "restart"),
          // Async command dispatch can replay after a lost response; never replay a restart.
          longRunning: false,
        },
      );
    } catch (error) {
      if (!isWorkerRestartConnectionLoss(error)) {
        this.failStep(userId, job, "restart", error);
        return;
      }
      this.appendLog(
        userId, job, "system",
        `Restart connection lost; checking worker recovery: ${getErrorMessage(error)}`,
        "restart",
      );
    }
    if (result && !result.success) {
      this.failStep(userId, job, "restart", new DomainError(
        "worker_restart_command_failed",
        `clanky worker service restart exited with code ${String(result.exitCode)}.`,
      ), result.exitCode);
      return;
    }
    this.appendLog(
      userId, job, "system",
      "Waiting up to 20 seconds for Mesh health and the worker service to be running.",
      "restart",
    );
    try {
      await confirmWorkerRestart({
        userId,
        workerNodeId: worker.workerNodeId,
        createExecutor: () => this.acquireExecutor(userId, job, worker),
        onRetry: (error) => this.appendLog(
          userId, job, "system",
          `Worker is not ready; checking again: ${getErrorMessage(error)}`,
          "restart",
        ),
      });
    } catch (error) {
      if (error instanceof DomainError && error.code === "worker_restart_confirmation_timeout") {
        this.markCommandUnconfirmed(userId, job, "restart", error);
      } else {
        this.failStep(userId, job, "restart", error);
      }
      return;
    }
    job = this.succeedStep(userId, job, "restart", result?.exitCode);
    this.appendLog(
      userId, job, "system",
      "Worker restart confirmed: Mesh health succeeded and the worker service is installed and running.",
      "restart",
    );
    this.completeJob(userId, job);
  }

  private async acquireExecutor(
    userId: string,
    job: WorkerUpdateJob,
    worker: MeshWorkerRegistration,
  ): Promise<CommandExecutor> {
    if (!worker.workerAcceptRemoteExecution) {
      throw new DomainError(
        "execution_host_unavailable",
        "This worker does not accept remote command execution.",
      );
    }
    const ref = getWorkerRegistrationExecutionHostRef(worker);
    const binding = executionHostService.getBinding(ref, userId);
    executionHostService.requireBindingCapability(
      binding,
      "commandExecution",
      userId,
    );
    return await executionHostService.getCommandExecutor(binding, {
      operationId: `worker-update:${job.config.id}`,
      directory: worker.workerDirectory?.trim() || ".",
      provider: DEFAULT_EXECUTION_AGENT_PROVIDER,
      localUserId: userId,
    });
  }

  private commandOptions(
    userId: string,
    job: WorkerUpdateJob,
    step: WorkerUpdateStep,
  ): Parameters<CommandExecutor["exec"]>[2] {
    return {
      timeout: null,
      maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
      longRunning: true,
      logFailures: false,
      onStdoutChunk: (text) => this.appendLog(userId, job, "stdout", text, step),
      onStderrChunk: (text) => this.appendLog(userId, job, "stderr", text, step),
    };
  }

  private beginJob(userId: string, job: WorkerUpdateJob): WorkerUpdateJob {
    const now = new Date().toISOString();
    return this.persistState(userId, job, {
      status: "running",
      currentStep: "update",
      startedAt: now,
      steps: {
        ...job.state.steps,
        update: {
          ...job.state.steps.update,
          status: "running",
          startedAt: now,
        },
      },
    });
  }

  private beginStep(
    userId: string,
    job: WorkerUpdateJob,
    step: WorkerUpdateStep,
  ): WorkerUpdateJob {
    const now = new Date().toISOString();
    return this.persistState(userId, job, {
      status: "running",
      currentStep: step,
      steps: {
        ...job.state.steps,
        [step]: {
          ...job.state.steps[step],
          status: "running",
          startedAt: now,
          error: undefined,
        },
      },
    });
  }

  private succeedStep(
    userId: string,
    job: WorkerUpdateJob,
    step: WorkerUpdateStep,
    exitCode?: number,
  ): WorkerUpdateJob {
    const now = new Date().toISOString();
    return this.persistState(userId, job, {
      currentStep: null,
      steps: {
        ...job.state.steps,
        [step]: {
          ...job.state.steps[step],
          status: "succeeded",
          completedAt: now,
          ...(exitCode === undefined ? {} : { exitCode }),
          error: undefined,
        },
      },
    });
  }

  private failStep(
    userId: string,
    job: WorkerUpdateJob,
    step: WorkerUpdateStep,
    error: unknown,
    exitCode?: number,
  ): WorkerUpdateJob {
    const now = new Date().toISOString();
    const jobError = toJobError(error, step, "worker_update_failed");
    const steps = {
      ...job.state.steps,
      [step]: {
        ...job.state.steps[step],
        status: "failed" as const,
        completedAt: now,
        ...(exitCode === undefined ? {} : { exitCode }),
        error: jobError.message,
      },
      ...(step === "update"
        ? {
            restart: {
              ...job.state.steps.restart,
              status: "skipped" as const,
              completedAt: now,
              error: "Skipped because clanky update did not succeed.",
            },
          }
        : {}),
    };
    const failed = this.persistState(userId, job, {
      status: "failed",
      currentStep: null,
      steps,
      error: jobError,
      completedAt: now,
    });
    this.appendLog(
      userId,
      failed,
      "system",
      step === "update"
        ? "clanky update did not succeed; restart was skipped."
        : "clanky worker service restart failed.",
      step,
    );
    return failed;
  }

  private completeJob(userId: string, job: WorkerUpdateJob): WorkerUpdateJob {
    const now = new Date().toISOString();
    return this.persistState(userId, job, {
      status: "completed",
      currentStep: null,
      completedAt: now,
      error: undefined,
    });
  }

  private persistState(
    userId: string,
    job: WorkerUpdateJob,
    updates: Partial<WorkerUpdateJobState>,
  ): WorkerUpdateJob {
    const next: WorkerUpdateJob = {
      ...job,
      state: {
        ...job.state,
        ...updates,
        updatedAt: new Date().toISOString(),
      },
    };
    updateWorkerUpdateJob(userId, next);
    emitWorkerUpdateJobChanged(next, userId);
    return next;
  }

  private appendLog(
    userId: string,
    job: WorkerUpdateJob,
    source: WorkerUpdateLogEntry["source"],
    text: string,
    step?: WorkerUpdateStep,
  ): void {
    if (!text) {
      return;
    }
    const redacted = redactLogText(text);
    const entry: WorkerUpdateLogEntry = {
      id: crypto.randomUUID(),
      source,
      text: redacted.length > MAX_LOG_TEXT_LENGTH
        ? `${redacted.slice(0, MAX_LOG_TEXT_LENGTH)} [truncated]`
        : redacted,
      timestamp: new Date().toISOString(),
      ...(step ? { step } : {}),
    };
    try {
      if (!appendWorkerUpdateJobLog(userId, job.config.id, entry)) {
        log.warn("Worker update log was not attached to its job", {
          workerNodeId: job.config.workerNodeId,
          jobId: job.config.id,
        });
        return;
      }
      emitWorkerUpdateJobChanged(job, userId, entry.timestamp);
    } catch (error) {
      log.error("Failed to persist worker update log", {
        workerNodeId: job.config.workerNodeId,
        jobId: job.config.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private reconcileUnexpectedFailure(
    userId: string,
    job: WorkerUpdateJob,
    commandInFlight: WorkerUpdateStep | null,
    error: unknown,
  ): void {
    try {
      const persisted = loadWorkerUpdateJob(userId, job.config.id);
      const current = persisted?.job ?? job;
      if (
        current.state.status === "completed"
        || current.state.status === "failed"
        || current.state.status === "interrupted"
      ) {
        return;
      }
      if (commandInFlight) {
        this.markCommandUnconfirmed(userId, current, commandInFlight, error);
        return;
      }
      if (current.state.steps.restart.status === "succeeded") {
        const completed = this.completeJob(userId, current);
        this.appendLog(
          userId,
          completed,
          "system",
          "Worker update job completed.",
        );
        return;
      }
      if (current.state.steps.update.status === "succeeded") {
        this.failPipelineBeforeRestart(userId, current, error);
        return;
      }
      this.failStep(userId, current, "update", error);
    } catch (finalizationError) {
      log.error("Failed to reconcile unexpected worker update failure", {
        workerNodeId: job.config.workerNodeId,
        jobId: job.config.id,
        error: finalizationError instanceof Error
          ? finalizationError.message
          : String(finalizationError),
        cause: getErrorMessage(error),
      });
    }
  }

  private markCommandUnconfirmed(
    userId: string,
    job: WorkerUpdateJob,
    step: WorkerUpdateStep,
    error: unknown,
  ): void {
    const now = new Date().toISOString();
    const message = step === "restart"
      ? `The restart command was dispatched, but its result could not be confirmed: ${getErrorMessage(error)}`
      : `The update command result could not be confirmed; restart was skipped: ${getErrorMessage(error)}`;
    const jobError: WorkerUpdateJobError = {
      code: step === "restart" ? "restart_unconfirmed" : "update_unconfirmed",
      message,
      step,
    };
    const steps = {
      ...job.state.steps,
      [step]: {
        ...job.state.steps[step],
        status: "unconfirmed" as const,
        completedAt: now,
        error: message,
      },
      ...(step === "update"
        ? {
            restart: {
              ...job.state.steps.restart,
              status: "skipped" as const,
              completedAt: now,
              error: "Skipped because clanky update did not complete with a confirmed success.",
            },
          }
        : {}),
    };
    const interrupted = this.persistState(userId, job, {
      status: "interrupted",
      currentStep: null,
      steps,
      error: jobError,
      completedAt: now,
    });
    this.appendLog(userId, interrupted, "system", message, step);
  }

  private failPipelineBeforeRestart(
    userId: string,
    job: WorkerUpdateJob,
    error: unknown,
  ): void {
    const now = new Date().toISOString();
    const message = `The update succeeded, but the restart step could not be started: ${getErrorMessage(error)}`;
    const interrupted = this.persistState(userId, job, {
      status: "failed",
      currentStep: null,
      steps: {
        ...job.state.steps,
        restart: {
          ...job.state.steps.restart,
          status: "skipped",
          completedAt: now,
          error: "Skipped because the restart step could not be started.",
        },
      },
      error: {
        code: "worker_update_pipeline_failed",
        message,
        step: "restart",
      },
      completedAt: now,
    });
    this.appendLog(userId, interrupted, "system", message, "restart");
  }
}
