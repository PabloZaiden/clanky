import type { CommandExecutor, CommandResult } from "../command-executor";
import type { ProvisioningStep } from "@/shared";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "./constants";
import { ProvisioningCancelledError, ProvisioningFailedError } from "./errors";
import { appendLog, appendSystemLog } from "./job-logger";
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
}

export async function runProvisioningCommand(
  record: ProvisioningJobRecord,
  executor: CommandExecutor,
  options: RunCommandOptions,
  maxLogEntries: number,
): Promise<CommandResult> {
  appendSystemLog(record, maxLogEntries, options.label, options.step);

  const result = await executor.exec(options.command, options.args, {
    cwd: options.cwd,
    timeout: options.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
    signal: record.abortController.signal,
    ...(options.streamOutput
      ? {
          onStdoutChunk: (chunk: string) =>
            appendLog(record, maxLogEntries, "stdout", chunk, options.step),
          onStderrChunk: (chunk: string) =>
            appendLog(record, maxLogEntries, "stderr", chunk, options.step),
        }
      : {}),
  });

  if (record.abortController.signal.aborted) {
    throw new ProvisioningCancelledError("Provisioning job was cancelled");
  }

  if (!result.success) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || options.errorMessage || "Command failed";
    throw new ProvisioningFailedError(
      options.errorCode ?? "command_failed",
      options.step,
      options.errorMessage ? `${options.errorMessage}: ${detail}` : detail,
    );
  }

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
