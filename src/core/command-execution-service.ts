/**
 * Shared bounded command execution semantics for workspaces and execution hosts.
 */

import { posix as pathPosix } from "node:path";
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

export interface CommandExecutionErrorCodes {
  cwdInvalid: string;
  cwdNotFound: string;
  outputLimitExceeded: string;
  targetLabel: string;
}

export function resolveCommandWorkingDirectory(
  rootDirectory: string,
  requestedCwd: string | undefined,
  errors: Pick<CommandExecutionErrorCodes, "cwdInvalid">,
): string {
  const root = pathPosix.normalize(rootDirectory.trim());
  if (!root.startsWith("/") || root.includes("\0")) {
    throw new DomainError(
      errors.cwdInvalid,
      "The execution root is not a valid absolute path.",
    );
  }
  if (requestedCwd === undefined) {
    return root;
  }

  const cwd = requestedCwd.trim();
  if (!cwd || cwd.includes("\0")) {
    throw new DomainError(
      errors.cwdInvalid,
      "The execution cwd must be a non-empty path without NUL bytes.",
    );
  }
  return pathPosix.normalize(cwd.startsWith("/") ? cwd : pathPosix.join(root, cwd));
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
  const cwd = resolveCommandWorkingDirectory(rootDirectory, request.cwd, errors);
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
