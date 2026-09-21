/**
 * Executes bounded commands directly on a registered execution host.
 */

import type {
  ExecutionHostExecRequest,
  ExecutionHostExecResponse,
} from "@/contracts";
import {
  serializeExecutionHostRef,
  type ExecutionHostRef,
} from "@/shared";
import { executeCommand } from "./command-execution-service";
import { closeCommandExecutor } from "./command-executor";
import { executionHostService } from "./execution-host-service";
import { requireCurrentUserId } from "../context/user-context";

export class ExecutionHostCommandService {
  async execute(
    ref: ExecutionHostRef,
    request: ExecutionHostExecRequest,
    signal: AbortSignal | undefined,
    userId: string = requireCurrentUserId(),
    sshPassword?: string,
  ): Promise<ExecutionHostExecResponse> {
    const binding = executionHostService.getBinding(ref, userId);
    const workingDirectory = await executionHostService.resolveWorkingDirectory(ref, {
      userId,
      sshPassword,
    });
    const executor = await executionHostService.getCommandExecutor(binding, {
      operationId: `execution-host-exec:${crypto.randomUUID()}`,
      directory: workingDirectory.directory,
      localUserId: userId,
      sshPassword,
    });

    try {
      return {
        executionHost: serializeExecutionHostRef(ref),
        ...await executeCommand(
          executor,
          workingDirectory.directory,
          request,
          signal,
          {
            cwdInvalid: "execution_host_exec_cwd_invalid",
            cwdNotFound: "execution_host_exec_cwd_not_found",
            outputLimitExceeded: "execution_host_exec_output_limit_exceeded",
            targetLabel: "execution host",
          },
        ),
      };
    } finally {
      closeCommandExecutor(executor);
    }
  }
}

export const executionHostCommandService = new ExecutionHostCommandService();
