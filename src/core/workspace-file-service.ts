/**
 * Workspace file explorer service.
 */

import { backendManager } from "./backend-manager";
import { fileExplorerService } from "./file-explorer-service";
import type {
  Workspace,
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceFileWriteResponse,
} from "../types";

class WorkspaceFileService {
  async listDirectory(
    workspace: Workspace,
    requestedPath = "",
    options?: { includeHidden?: boolean },
  ): Promise<WorkspaceFileListResponse> {
    const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
    const response = await fileExplorerService.listDirectory({
      id: workspace.id,
      rootDirectory: workspace.directory,
      pathScopeLabel: "workspace",
      executor,
    }, requestedPath, options);

    return {
      workspaceId: workspace.id,
      directory: response.directory,
      entries: response.entries,
    };
  }

  async readFile(workspace: Workspace, requestedPath: string): Promise<WorkspaceFileReadResponse> {
    const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
    const response = await fileExplorerService.readFile({
      id: workspace.id,
      rootDirectory: workspace.directory,
      pathScopeLabel: "workspace",
      executor,
    }, requestedPath);

    return {
      workspaceId: workspace.id,
      file: response.file,
      content: response.content,
    };
  }

  async getMetadata(workspace: Workspace, requestedPath: string) {
    const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
    return await fileExplorerService.getMetadata({
      id: workspace.id,
      rootDirectory: workspace.directory,
      pathScopeLabel: "workspace",
      executor,
    }, requestedPath);
  }

  async writeFile(
    workspace: Workspace,
    requestedPath: string,
    content: string,
    options?: {
      expectedVersionToken?: string | null;
      overwrite?: boolean;
    },
  ): Promise<WorkspaceFileWriteResponse> {
    const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
    const response = await fileExplorerService.writeFile({
      id: workspace.id,
      rootDirectory: workspace.directory,
      pathScopeLabel: "workspace",
      executor,
    }, requestedPath, content, options);

    return {
      success: response.success,
      workspaceId: workspace.id,
      file: response.file,
      overwritten: response.overwritten,
    };
  }
}

export const workspaceFileService = new WorkspaceFileService();
