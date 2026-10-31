/**
 * File explorer routes for local and Mesh execution hosts.
 */

import {
  executionHostRefFromParts,
  type ExecutionHostRef,
} from "@/shared";
import { executionHostService } from "../core/execution-host-service";
import {
  resolveFileExplorerRootDirectory,
  type FileExplorerTarget,
} from "../core/file-explorer-service";
import { fileSystemTargetFingerprint } from "../core/file-system-service";
import { DomainError } from "../domain/domain-error";
import { createFileExplorerRoutes } from "./file-explorer-routes";
import { createFileSystemRoutes } from "./file-system-routes";
import type { FileExplorerRouteConfig } from "./file-explorer-routes";

function parseRef(req: Request, id: string): ExecutionHostRef {
  const segments = new URL(req.url).pathname.split("/");
  const ref = executionHostRefFromParts(segments[3] ?? "", id);
  if (ref) {
    return ref;
  }
  throw new DomainError(
    "execution_host_kind_invalid",
    "Execution host kind must be local or mesh.",
  );
}

async function resolveExecutionHostFileTarget(
  req: Request,
  id: string,
  startDirectory?: string,
): Promise<FileExplorerTarget> {
  const ref = parseRef(req, id);
  const host = await executionHostService.requireCapability(ref, "fileOperations");

  const defaultRoot = (await executionHostService.resolveWorkingDirectory(ref)).directory;
  const executor = await executionHostService.getCommandExecutorForRef(ref, {
    operationId: `file-explorer:${id}`,
    directory: defaultRoot,
  });
  return {
    id,
    rootDirectory: await resolveFileExplorerRootDirectory(
      executor,
      defaultRoot,
      startDirectory,
    ),
    executor,
    commandExecutionAvailable: (host.capabilities["commandExecution"] ?? 0) >= 1,
    fileSystemIdentity: host.targetKey,
    fileSystemTarget: fileSystemTargetFingerprint([ref, host.revision]),
  };
}

const configuration: FileExplorerRouteConfig = {
  basePath: "/api/execution-hosts/:kind/:id/files",
  logName: "execution-host-files",
  resourceLabel: "execution host",
  responseIdField: "serverId",
  invalidPathError: "invalid_server_path",
  internalError: "execution_host_file_error",
  resolveTarget: resolveExecutionHostFileTarget,
};

export const executionHostFilesRoutes = {
  ...createFileExplorerRoutes(configuration),
  ...createFileSystemRoutes(configuration),
};
