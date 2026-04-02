/**
 * Workspace file explorer service.
 */

import { backendManager } from "./backend-manager";
import { fileExplorerService, resolveFileExplorerRootDirectory } from "./file-explorer-service";
import type {
  Workspace,
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceFileWriteResponse,
} from "../types";

class WorkspaceFileService {
  private async getTarget(workspace: Workspace, startDirectory?: string) {
    const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
    const rootDirectory = await resolveFileExplorerRootDirectory(
      executor,
      startDirectory?.trim() || workspace.directory,
    );
    return {
      id: workspace.id,
      rootDirectory,
      pathScopeLabel: "active workspace explorer root",
      executor,
    };
  }

  async listDirectory(
    workspace: Workspace,
    requestedPath = "",
    options?: { includeHidden?: boolean; startDirectory?: string },
  ): Promise<WorkspaceFileListResponse> {
    const target = await this.getTarget(workspace, options?.startDirectory);
    const response = await fileExplorerService.listDirectory(target, requestedPath, options);

    return {
      workspaceId: workspace.id,
      directory: response.directory,
      entries: response.entries,
    };
  }

  async readFile(
    workspace: Workspace,
    requestedPath: string,
    options?: { startDirectory?: string },
  ): Promise<WorkspaceFileReadResponse> {
    const target = await this.getTarget(workspace, options?.startDirectory);
    const response = await fileExplorerService.readFile(target, requestedPath);

    return {
      workspaceId: workspace.id,
      file: response.file,
      content: response.content,
    };
  }

  async getMetadata(
    workspace: Workspace,
    requestedPath: string,
    options?: { startDirectory?: string },
  ) {
    const target = await this.getTarget(workspace, options?.startDirectory);
    return await fileExplorerService.getMetadata(target, requestedPath);
  }

  async writeFile(
    workspace: Workspace,
    requestedPath: string,
    content: string,
    options?: {
      expectedVersionToken?: string | null;
      overwrite?: boolean;
      startDirectory?: string;
    },
  ): Promise<WorkspaceFileWriteResponse> {
    const target = await this.getTarget(workspace, options?.startDirectory);
    const response = await fileExplorerService.writeFile(target, requestedPath, content, options);

    return {
      success: response.success,
      workspaceId: workspace.id,
      file: response.file,
      overwritten: response.overwritten,
    };
  }
}

export const workspaceFileService = new WorkspaceFileService();
