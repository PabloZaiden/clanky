/**
 * Workspace file explorer target adapter.
 */

import { backendManager } from "../../core/backend-manager";
import { executionHostService } from "../../core/execution-host-service";
import {
  resolveFileExplorerRootDirectory,
  type FileExplorerTarget,
} from "../../core/file-explorer-service";
import { createFileExplorerRoutes } from "../file-explorer-routes";
import { requireWorkspace } from "../helpers";

async function resolveWorkspaceFileTarget(
  _req: Request,
  workspaceId: string,
  startDirectory?: string,
): Promise<FileExplorerTarget> {
  const workspaceResult = await requireWorkspace(workspaceId);
  if (workspaceResult instanceof Response) {
    throw workspaceResult;
  }
  executionHostService.requireBindingCapability(
    workspaceResult.executionHostBinding,
    "fileOperations",
  );

  const executor = await backendManager.getCommandExecutorAsync(
    workspaceResult.id,
    workspaceResult.directory,
  );
  const rootDirectory = await resolveFileExplorerRootDirectory(
    executor,
    workspaceResult.directory,
    startDirectory,
  );

  return {
    id: workspaceResult.id,
    rootDirectory,
    executor,
  };
}

export const workspaceFilesRoutes = createFileExplorerRoutes({
  basePath: "/api/workspaces/:id/files",
  logName: "workspace-files",
  resourceLabel: "workspace",
  responseIdField: "workspaceId",
  invalidPathError: "invalid_workspace_path",
  internalError: "workspace_file_error",
  downloadDescription: "Stream a workspace file from the selected execution host.",
  resolveTarget: resolveWorkspaceFileTarget,
});
