/**
 * Executes one-shot commands on the host selected by a workspace.
 */

import { posix as pathPosix } from "node:path";
import type { WorkspaceExecRequest, WorkspaceExecResponse } from "@/contracts";
import { WORKSPACE_EXEC_MAX_OUTPUT_BYTES } from "@/shared/mesh-execution";
import { backendManager } from "./backend-manager";
import {
  isCommandOutputLimitError,
  type CommandExecutor,
} from "./command-executor";
import { DomainError } from "./domain-error";
import { workspaceManager } from "./workspace-manager";

export interface WorkspaceCommandServiceDependencies {
  workspaceProvider?: Pick<typeof workspaceManager, "getWorkspace">;
  executorProvider?: Pick<typeof backendManager, "getCommandExecutorAsync">;
}

function resolveWorkingDirectory(workspaceDirectory: string, requestedCwd?: string): string {
  const root = pathPosix.normalize(workspaceDirectory.trim());
  if (!root.startsWith("/") || root.includes("\0")) {
    throw new DomainError(
      "workspace_exec_cwd_invalid",
      "The workspace directory is not a valid absolute path.",
    );
  }
  if (requestedCwd === undefined) {
    return root;
  }

  const cwd = requestedCwd.trim();
  if (!cwd || cwd.includes("\0")) {
    throw new DomainError(
      "workspace_exec_cwd_invalid",
      "The execution cwd must be a non-empty path without NUL bytes.",
    );
  }
  return pathPosix.normalize(cwd.startsWith("/") ? cwd : pathPosix.join(root, cwd));
}

async function requireExecutionDirectory(
  executor: CommandExecutor,
  cwd: string,
): Promise<void> {
  if (await executor.directoryExists(cwd)) {
    return;
  }
  throw new DomainError(
    "workspace_exec_cwd_not_found",
    "The execution cwd does not exist or is not a directory.",
    { details: { cwd } },
  );
}

export class WorkspaceCommandService {
  private readonly workspaceProvider: Pick<typeof workspaceManager, "getWorkspace">;
  private readonly executorProvider: Pick<typeof backendManager, "getCommandExecutorAsync">;

  constructor(dependencies: WorkspaceCommandServiceDependencies = {}) {
    this.workspaceProvider = dependencies.workspaceProvider ?? workspaceManager;
    this.executorProvider = dependencies.executorProvider ?? backendManager;
  }

  async execute(
    workspaceId: string,
    request: WorkspaceExecRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceExecResponse> {
    const workspace = await this.workspaceProvider.getWorkspace(workspaceId);
    if (!workspace) {
      throw new DomainError("workspace_not_found", "Workspace not found", {
        details: { workspaceId },
      });
    }

    const cwd = resolveWorkingDirectory(workspace.directory, request.cwd);
    const executor = await this.executorProvider.getCommandExecutorAsync(
      workspace.id,
      workspace.directory,
    );
    await requireExecutionDirectory(executor, cwd);

    try {
      const result = await executor.exec(request.command, request.args, {
        cwd,
        timeout: request.timeoutMs,
        maxOutputBytes: WORKSPACE_EXEC_MAX_OUTPUT_BYTES,
        signal,
        logFailures: false,
      });
      return {
        workspaceId: workspace.id,
        ...result,
      };
    } catch (error) {
      if (isCommandOutputLimitError(error)) {
        throw new DomainError(
          "workspace_exec_output_limit_exceeded",
          `Command ${error.stream} exceeded the ${String(error.maxBytes)} byte output limit.`,
          {
            cause: error,
            details: {
              stream: error.stream,
              maxBytes: error.maxBytes,
            },
          },
        );
      }
      throw error;
    }
  }
}

export const workspaceCommandService = new WorkspaceCommandService();
