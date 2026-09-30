/**
 * Workspace file explorer target adapter.
 */

import { backendManager } from "../../core/backend-manager";
import { executionHostService } from "../../core/execution-host-service";
import { fileSystemTargetFingerprint } from "../../core/file-system-service";
import {
  resolveFileExplorerRootDirectory,
  type FileExplorerTarget,
} from "../../core/file-explorer-service";
import { createFileExplorerRoutes } from "../file-explorer-routes";
import { createFileSystemRoutes } from "../file-system-routes";
import type { FileExplorerRouteConfig } from "../file-explorer-routes";
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
  const host = executionHostService.requireBindingCapability(
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
    commandExecutionAvailable: (host.runtime.capabilities["commandExecution"] ?? 0) >= 1,
    fileSystemIdentity: workspaceResult.executionHostBinding.targetKey,
    fileSystemTarget: fileSystemTargetFingerprint([
      workspaceResult.executionHostBinding, workspaceResult.executionTargetRevision,
      workspaceResult.directory,
    ]),
  };
}

const configuration: FileExplorerRouteConfig = {
  basePath: "/api/workspaces/:id/files",
  logName: "workspace-files",
  resourceLabel: "workspace",
  responseIdField: "workspaceId",
  invalidPathError: "invalid_workspace_path",
  internalError: "workspace_file_error",
  downloadDescription: "Stream a workspace file from the selected execution host.",
  resolveTarget: resolveWorkspaceFileTarget,
};

export const workspaceFilesRoutes = {
  ...createFileExplorerRoutes(configuration),
  ...createFileSystemRoutes(configuration),
};
