/**
 * Shared bounded command execution semantics for workspaces and execution hosts.
 */

import type {
  CommandExecRequest,
  CommandExecResult,
} from "@/contracts/schemas";
import { WORKSPACE_EXEC_MAX_OUTPUT_BYTES } from "@/shared/mesh-execution";
import {
  isCommandOutputLimitError,
  type CommandExecutor,
} from "./command-executor";
import { DomainError } from "./domain-error";
import {
  ExecutionPathError,
  normalizeExecutionPath,
  resolveExecutionPathFromDirectory,
  type ExecutionPathStyle,
} from "./execution-path";

export interface CommandExecutionErrorCodes {
  cwdInvalid: string;
  cwdNotFound: string;
  outputLimitExceeded: string;
  targetLabel: string;
}

export function resolveCommandWorkingDirectory(
  rootDirectory: string,
  requestedCwd: string | undefined,
  pathStyle: ExecutionPathStyle,
  errors: Pick<CommandExecutionErrorCodes, "cwdInvalid">,
): string {
  try {
    const root = normalizeExecutionPath(rootDirectory.trim(), pathStyle);
    return requestedCwd === undefined
      ? root
      : resolveExecutionPathFromDirectory(root, requestedCwd.trim(), pathStyle);
  } catch (error) {
    if (!(error instanceof ExecutionPathError)) {
      throw error;
    }
    throw new DomainError(
      errors.cwdInvalid,
      "The execution cwd is not a valid path for the selected host.",
      { cause: error, details: { pathStyle } },
    );
  }
}

async function requireExecutionDirectory(
  executor: CommandExecutor,
  cwd: string,
  errors: Pick<CommandExecutionErrorCodes, "cwdNotFound">,
): Promise<void> {
  if (await executor.directoryExists(cwd)) {
    return;
  }
  throw new DomainError(
    errors.cwdNotFound,
    "The execution cwd does not exist or is not a directory.",
    { details: { cwd } },
  );
}

export async function executeCommand(
  executor: CommandExecutor,
  rootDirectory: string,
  request: CommandExecRequest,
  signal: AbortSignal | undefined,
  errors: CommandExecutionErrorCodes,
): Promise<CommandExecResult> {
  const cwd = resolveCommandWorkingDirectory(
    rootDirectory,
    request.cwd,
    executor.pathStyle,
    errors,
  );
  await requireExecutionDirectory(executor, cwd, errors);

  try {
    return await executor.exec(request.command, request.args, {
      cwd,
      timeout: request.timeoutMs,
      maxOutputBytes: WORKSPACE_EXEC_MAX_OUTPUT_BYTES,
      signal,
      logFailures: false,
    });
  } catch (error) {
    if (isCommandOutputLimitError(error)) {
      throw new DomainError(
        errors.outputLimitExceeded,
        `Command ${error.stream} exceeded the ${String(error.maxBytes)} byte output limit.`,
        {
          cause: error,
          details: {
            stream: error.stream,
            maxBytes: error.maxBytes,
            target: errors.targetLabel,
          },
        },
      );
    }
    throw error;
  }
}
