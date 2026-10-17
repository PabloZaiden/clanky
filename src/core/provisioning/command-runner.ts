import type { CommandExecutor, CommandResult } from "../command-executor";
import type { CommandExecutionState, ProvisioningCommandExecution, ProvisioningStep } from "@/shared";
import { DomainError } from "../../domain/domain-error";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "./constants";
import { ProvisioningCancelledError, ProvisioningFailedError } from "./errors";
import { appendLog, appendSystemLog, persistProvisioningState } from "./job-logger";
import type { ProvisioningJobRecord } from "./types";

export interface RunCommandOptions {
  step: ProvisioningStep;
  label: string;
  command: string;
  args: string[];
  cwd?: string;
  timeout?: number;
  streamOutput?: boolean;
  errorCode?: string;
  errorMessage?: string;
  captureStdout?: boolean;
  captureStderr?: boolean;
  longRunning?: boolean;
  signal?: AbortSignal;
}

function persistExecution(
  record: ProvisioningJobRecord,
  execution: ProvisioningCommandExecution,
): void {
  persistProvisioningState(record, {
    execution,
    ...(execution.state !== "not_started" ? { hasDispatchedCommands: true } : {}),
    ...(execution.state === "started" && !record.job.state.startedAt
      ? { startedAt: new Date().toISOString() } : {}),
  }, "runProvisioningCommand");
}

function commandError(
  record: ProvisioningJobRecord,
  options: RunCommandOptions,
  error: unknown,
): ProvisioningFailedError | ProvisioningCancelledError {
  const details = error instanceof DomainError ? error.details : {};
  const execution = record.job.state.execution!;
  if (record.abortController.signal.aborted && execution.state === "not_started") {
    throw new ProvisioningCancelledError("Provisioning job was cancelled");
  }
  const started = execution.state === "started" || details["executionStarted"] === true;
  const interrupted = started && details["terminationConfirmed"] === true;
  const notDispatched = execution.state === "not_started" && details["executionRequestDispatched"] !== true;
  const receivedFailure = details["executionResultReceived"] === true
    && error instanceof DomainError
    && !["mesh_execution_aborted", "mesh_execution_response_invalid", "mesh_execution_output_gap",
      "mesh_execution_cancel_failed", "mesh_execution_result_too_large"].includes(error.code);
  const outcome = interrupted ? "interrupted" : receivedFailure ? "failed" : "unconfirmed";
  persistExecution(record, { ...execution, outcome: notDispatched ? undefined : outcome });
  if (record.abortController.signal.aborted) {
    return new ProvisioningCancelledError("Provisioning job was cancelled", { cause: error });
  }
  return new ProvisioningFailedError(
    notDispatched ? "provisioning_connection_failed"
      : interrupted ? "provisioning_execution_interrupted"
        : receivedFailure && error instanceof DomainError ? error.code : "provisioning_execution_unconfirmed",
    options.step,
    notDispatched ? "Could not connect before the command started."
      : error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}

function recordResult(
  { record, options, result, executionStarted }: {
    record: ProvisioningJobRecord;
    options: RunCommandOptions;
    result: CommandResult;
    executionStarted: boolean;
  },
): void {
  const execution = record.job.state.execution!;
  if (record.abortController.signal.aborted && execution.state === "not_started") {
    throw new ProvisioningCancelledError("Provisioning job was cancelled");
  }
  const ssh = record.job.config.executionHostBinding.host.kind === "ssh";
  // SSH's local client termination/exit 255 cannot prove a remote command outcome.
  const unconfirmed = result.termination === "failed"
    || (ssh && (result.exitCode === 255 || result.termination !== undefined))
    || (result.termination === "confirmed" && !executionStarted && result.exitCode !== 124);
  const interrupted = !unconfirmed && result.termination === "confirmed";
  const outcome = unconfirmed ? "unconfirmed" : interrupted ? "interrupted"
    : result.success ? "succeeded" : "failed";
  persistExecution(record, {
    ...execution,
    state: unconfirmed ? execution.state : "finished",
    outcome,
    ...(!result.termination && !unconfirmed ? { exitCode: result.exitCode } : {}),
  });
  if (record.abortController.signal.aborted) {
    throw new ProvisioningCancelledError("Provisioning job was cancelled");
  }
  if (unconfirmed || interrupted) {
    throw new ProvisioningFailedError(
      unconfirmed ? "provisioning_execution_unconfirmed" : "provisioning_execution_interrupted",
      options.step,
      unconfirmed ? "The command outcome could not be confirmed." : "Command execution was interrupted.",
    );
  }
  if (!result.success) {
    const detail = result.stderr.trim() || result.stdout.trim() || options.errorMessage || "Command failed";
    throw new ProvisioningFailedError(
      options.errorCode ?? "command_failed", options.step,
      options.errorMessage ? `${options.errorMessage}: ${detail}` : detail,
    );
  }
}

export async function runProvisioningCommand(
  record: ProvisioningJobRecord,
  executor: CommandExecutor,
  options: RunCommandOptions,
  maxLogEntries: number,
): Promise<CommandResult> {
  appendSystemLog(record, maxLogEntries, options.label, options.step);
  persistExecution(record, { step: options.step, state: "not_started" });
  let executionStarted = false;
  const observe = (state: CommandExecutionState): void => {
    if (state === "started") executionStarted = true;
    persistExecution(record, { step: options.step, state });
  };
  const output = (source: "stdout" | "stderr", text: string): void => {
    if (text && record.job.state.execution?.state !== "finished"
      && record.job.state.execution?.state !== "started"
      && (source === "stdout" || record.job.config.executionHostBinding.host.kind !== "ssh")) {
      observe("started");
    }
    if (options.streamOutput) appendLog(record, maxLogEntries, source, text, options.step);
  };
  let result: CommandResult;
  try {
    result = await executor.exec(options.command, options.args, {
      cwd: options.cwd,
      timeout: options.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
      signal: options.signal
        ? AbortSignal.any([record.abortController.signal, options.signal])
        : record.abortController.signal,
      onExecutionState: observe,
      onStdoutChunk: (text) => output("stdout", text),
      onStderrChunk: (text) => output("stderr", text),
      longRunning: options.longRunning,
      retryStart: false,
    });
  } catch (error) {
    throw commandError(record, options, error);
  }
  recordResult({ record, options, result, executionStarted });
  if (!options.streamOutput) {
    if (options.captureStdout !== false && result.stdout.trim()) {
      appendLog(record, maxLogEntries, "stdout", result.stdout, options.step);
    }
    if (options.captureStderr !== false && result.stderr.trim()) {
      appendLog(record, maxLogEntries, "stderr", result.stderr, options.step);
    }
  }
  return result;
}
