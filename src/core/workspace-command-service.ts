/**
 * Executes one-shot commands on the host selected by a workspace.
 */

import type { WorkspaceExecRequest, WorkspaceExecResponse } from "@/contracts";
import { backendManager } from "./backend-manager";
import { executeCommand } from "./command-execution-service";
import { DomainError } from "./domain-error";
import { workspaceManager } from "./workspace-manager";

export interface WorkspaceCommandServiceDependencies {
  workspaceProvider?: Pick<typeof workspaceManager, "getWorkspace">;
  executorProvider?: Pick<typeof backendManager, "getCommandExecutorAsync">;
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

    const executor = await this.executorProvider.getCommandExecutorAsync(
      workspace.id,
      workspace.directory,
    );
    return {
      workspaceId: workspace.id,
      ...await executeCommand(executor, workspace.directory, request, signal, {
        cwdInvalid: "workspace_exec_cwd_invalid",
        cwdNotFound: "workspace_exec_cwd_not_found",
        outputLimitExceeded: "workspace_exec_output_limit_exceeded",
        targetLabel: "workspace",
      }),
    };
  }
}

export const workspaceCommandService = new WorkspaceCommandService();
