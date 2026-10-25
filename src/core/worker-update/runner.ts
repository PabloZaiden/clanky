import type { MeshWorkerRegistration } from "@/shared/mesh";
import type {
  WorkerUpdateJob,
  WorkerUpdateJobError,
  WorkerUpdateJobState,
  WorkerUpdateLogEntry,
  WorkerUpdateStep,
  WorkerReleaseChannel,
} from "@/shared/worker-update";
import type { CommandExecutionState } from "@/shared/job-execution";
import { isWorkerUpdateJobTerminal } from "@/shared/worker-update";
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
import { workspaceWorkerEnrollmentService } from "../workspace-worker-enrollment-service";
import { emitWorkerUpdateJobChanged } from "./job-events";
import {
  confirmWorkerRestart,
  isWorkerRestartResponseLoss,
  WORKER_RESTART_TIMEOUT_MS,
  readWorkerServiceStatus,
  type WorkerServiceStatus,
} from "./restart-confirmation";

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
      this.appendLog(userId, job, "system", "Connecting to worker.", "update");
      executor = await this.acquireExecutor(userId, job, worker);
      const beforeUpdate = await readWorkerServiceStatus(executor);
      if (!beforeUpdate.installed || !beforeUpdate.running) {
        throw new DomainError(
          "worker_service_not_running",
          "Clanky needs a running worker service or workspace loop before it can be updated. Existing automatic workspaces need their launcher upgraded manually.",
        );
      }

      commandInFlight = "update";
      const updated = await this.updateWorker({ userId, initialJob: job, executor, beforeUpdate });
      commandInFlight = null;
      if (!updated) return;
      job = updated.job;

      await this.restartWorker({
        userId, initialJob: job, worker, executor, beforeUpdate,
        expectedVersion: updated.status.binaryVersion,
        expectedChannel: job.config.channel === "default" ? undefined : job.config.channel,
      });
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

  private async updateWorker({
    userId, initialJob, executor, beforeUpdate,
  }: {
    userId: string;
    initialJob: WorkerUpdateJob;
    executor: CommandExecutor;
    beforeUpdate: WorkerServiceStatus;
  }): Promise<{ job: WorkerUpdateJob; status: WorkerServiceStatus } | null> {
    let job = initialJob;
    const channel = job.config.channel === "default" ? undefined : job.config.channel;
    const result = await executor.exec(
      "clanky",
      ["update", ...(channel
        ? ["--channel", channel]
        : beforeUpdate.releaseChannel === "prerelease" ? ["--pre-release"] : [])],
      this.commandOptions(userId, () => job, "update", (next) => { job = next; }),
    );
    if (!result.success) {
      this.failStep(userId, job, "update", new DomainError(
        "worker_update_command_failed",
        `clanky update exited with code ${String(result.exitCode)}.`,
      ), result.exitCode);
      return null;
    }
    if (channel) {
      const configured = await executor.exec(
        "clanky",
        ["worker", "channel", channel],
        this.commandOptions(userId, () => job, "update", (next) => { job = next; }),
      );
      if (!configured.success) {
        this.failStep(userId, job, "update", new DomainError(
          "worker_release_channel_save_failed",
          "The binary was updated, but its default channel could not be saved. The installed Clanky must support worker channel stable|latest.",
        ), configured.exitCode);
        return null;
      }
    }
    const status = await readWorkerServiceStatus(executor);
    if (channel && status.releaseChannel !== channel) {
      this.failStep(userId, job, "update", new DomainError(
        "worker_release_channel_verification_failed",
        "The worker did not report the selected channel after saving its configuration.",
      ));
      return null;
    }
    job = this.succeedStep(userId, job, "update", result.exitCode);
    this.appendLog(userId, job, "system", `clanky update succeeded with exit code ${String(result.exitCode)}.`, "update");
    return { job, status };
  }

  private async restartWorker({
    userId,
    initialJob,
    worker,
    executor,
    beforeUpdate,
    expectedVersion,
    expectedChannel,
  }: {
    userId: string;
    initialJob: WorkerUpdateJob;
    worker: MeshWorkerRegistration;
    executor: CommandExecutor;
    beforeUpdate: WorkerServiceStatus;
    expectedVersion?: string;
    expectedChannel?: WorkerReleaseChannel;
  }): Promise<void> {
    let job = this.beginStep(userId, initialJob, "restart");
    const deadline = performance.now() + WORKER_RESTART_TIMEOUT_MS;
    this.appendLog(userId, job, "system", "Starting clanky worker service restart.", "restart");
    let result: CommandResult | undefined;
    const responseController = new AbortController();
    const responseTimer = setTimeout(
      () => responseController.abort(),
      Math.max(1, deadline - performance.now()),
    );
    try {
      result = await executor.exec(
        "clanky",
        ["worker", "service", "restart"],
        {
          ...this.commandOptions(userId, () => job, "restart", (next) => { job = next; }),
          // Observe independently so losing the response cannot kill or replay the restart.
          longRunning: true,
          preserveOnDisconnect: true,
          signal: responseController.signal,
        },
      );
    } catch (error) {
      if (!isWorkerRestartResponseLoss(error)) {
        this.finalizeCommandError(userId, job, "restart", error);
        return;
      }
      this.appendLog(
        userId, job, "system",
        `Restart connection lost; checking worker recovery: ${getErrorMessage(error)}`,
        "restart",
      );
    } finally {
      clearTimeout(responseTimer);
    }
    if (result && !result.success) {
      this.failStep(userId, job, "restart", new DomainError(
        "worker_restart_command_failed",
        `clanky worker service restart exited with code ${String(result.exitCode)}.`,
      ), result.exitCode);
      return;
    }
    job = this.persistState(userId, job, {
      status: "verifying",
      steps: {
        ...job.state.steps,
        restart: { ...job.state.steps.restart, status: "verifying" },
      },
    });
    this.appendLog(
      userId, job, "system",
      "Checking Mesh health and the worker service within the 20-second restart deadline.",
      "restart",
    );
    try {
      await confirmWorkerRestart({
        userId,
        workerNodeId: worker.workerNodeId,
        deadline,
        previousInstanceId: beforeUpdate.instanceId,
        expectedVersion,
        expectedChannel,
        createExecutor: () => this.acquireExecutor(userId, job, worker),
        onRetry: (error) => this.appendLog(
          userId, job, "system",
          `Worker is not ready; checking again: ${getErrorMessage(error)}`,
          "restart",
        ),
      });
    } catch (error) {
      // Probe failure cannot establish whether the already-dispatched restart failed.
      this.markCommandUnconfirmed(userId, job, "restart", error);
      return;
    }
    job = this.succeedStep(userId, job, "restart", result?.exitCode);
    this.appendLog(
      userId, job, "system",
      "Worker restart confirmed: Mesh health succeeded and Clanky is running under its service or workspace loop.",
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
    const binding = worker.registrationScope === "workspace" && worker.workspaceWorkerEnrollmentId
      ? workspaceWorkerEnrollmentService.getExecutionHostBinding(userId, worker.workspaceWorkerEnrollmentId)
      : executionHostService.getBinding(ref, userId);
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
    getJob: () => WorkerUpdateJob,
    step: WorkerUpdateStep,
    onState: (job: WorkerUpdateJob) => void,
  ): Parameters<CommandExecutor["exec"]>[2] {
    return {
      timeout: null,
      maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
      longRunning: true,
      logFailures: false,
      onExecutionState: (execution) => {
        const job = getJob();
        const now = new Date().toISOString();
        const previous = job.state.steps[step];
        onState(this.persistState(userId, job, {
          status: "running",
          ...(execution === "started" && !job.state.startedAt ? { startedAt: now } : {}),
          steps: {
            ...job.state.steps,
            [step]: {
              ...job.state.steps[step],
              execution: previous.execution === "started" && execution === "dispatched" ? "started" : execution,
              status: "running",
              ...(execution === "started" && !previous.startedAt ? { startedAt: now } : {}),
            },
          },
        }));
      },
      onStdoutChunk: (text) => this.appendLog(userId, getJob(), "stdout", text, step),
      onStderrChunk: (text) => this.appendLog(userId, getJob(), "stderr", text, step),
    };
  }

  private beginJob(userId: string, job: WorkerUpdateJob): WorkerUpdateJob {
    return this.persistState(userId, job, {
      status: "connecting",
      currentStep: "update",
      steps: {
        ...job.state.steps,
        update: {
          ...job.state.steps.update,
          status: "connecting",
          execution: "not_started",
        },
      },
    });
  }

  private beginStep(
    userId: string,
    job: WorkerUpdateJob,
    step: WorkerUpdateStep,
  ): WorkerUpdateJob {
    return this.persistState(userId, job, {
      status: "connecting",
      currentStep: step,
      steps: {
        ...job.state.steps,
        [step]: {
          ...job.state.steps[step],
          status: "connecting",
          execution: "not_started",
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
          ...(exitCode === undefined ? {} : { execution: "finished" }),
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
        ...(exitCode === undefined ? {} : { execution: "finished" as const }),
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
              error: "Skipped because the update and channel configuration did not succeed.",
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
        ? "The update and channel configuration did not succeed; restart was skipped."
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
      if (isWorkerUpdateJobTerminal(current.state.status)) {
        return;
      }
      if (commandInFlight) {
        this.finalizeCommandError(userId, current, commandInFlight, error);
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
      this.finalizeCommandError(userId, current, "update", error);
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
    const message = `Could not confirm ${step === "restart" ? "restart" : "update"} outcome: ${getErrorMessage(error)}`;
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
    const unconfirmed = this.persistState(userId, job, {
      status: "unconfirmed",
      currentStep: null,
      steps,
      error: jobError,
      completedAt: now,
    });
    this.appendLog(userId, unconfirmed, "system", message, step);
  }

  private finalizeCommandError(
    userId: string,
    job: WorkerUpdateJob,
    step: WorkerUpdateStep,
    error: unknown,
  ): void {
    const details = error instanceof DomainError ? error.details : {};
    const execution: CommandExecutionState | undefined = job.state.steps[step].execution;
    const started = execution === "started" || details["executionStarted"] === true;
    if (started && details["terminationConfirmed"] === true) {
      this.stopStep(userId, job, step, "interrupted", error);
    } else if (details["executionResultReceived"] === true
      && error instanceof DomainError && error.code !== "mesh_execution_response_invalid"
      && error.code !== "mesh_execution_output_gap"
      && error.code !== "mesh_execution_aborted"
      && error.code !== "mesh_execution_cancel_failed"
      && error.code !== "mesh_execution_result_too_large") {
      this.failStep(userId, job, step, error);
    } else if (execution === "not_started"
      && details["executionRequestDispatched"] !== true) {
      this.stopStep(userId, job, step, "connection_failed", error);
    } else {
      this.markCommandUnconfirmed(userId, job, step, error);
    }
  }

  private stopStep(
    userId: string,
    job: WorkerUpdateJob,
    step: WorkerUpdateStep,
    status: "connection_failed" | "interrupted",
    error: unknown,
  ): void {
    const now = new Date().toISOString();
    const jobError = toJobError(error, step, status);
    const stopped = this.persistState(userId, job, {
      status,
      currentStep: null,
      completedAt: now,
      error: jobError,
      steps: {
        ...job.state.steps,
        [step]: {
          ...job.state.steps[step],
          status,
          completedAt: now,
          error: jobError.message,
        },
        ...(step === "update" ? {
          restart: {
            status: "skipped",
            execution: "not_started",
            completedAt: now,
            error: "Update did not succeed.",
          },
        } : {}),
      },
    });
    this.appendLog(userId, stopped, "system", jobError.message, step);
  }

  private failPipelineBeforeRestart(
    userId: string,
    job: WorkerUpdateJob,
    error: unknown,
  ): void {
    const now = new Date().toISOString();
    const message = `The update succeeded, but the restart step could not be started: ${getErrorMessage(error)}`;
    const failed = this.persistState(userId, job, {
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
    this.appendLog(userId, failed, "system", message, "restart");
  }
}
