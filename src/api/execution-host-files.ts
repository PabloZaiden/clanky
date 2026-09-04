/**
 * File explorer routes for local, Mesh, and SSH execution hosts.
 */

import { executionHostRefsEqual, type ExecutionHostRef } from "@/shared";
import { executionHostService } from "../core/execution-host-service";
import {
  resolveFileExplorerRootDirectory,
  type FileExplorerTarget,
} from "../core/file-explorer-service";
import { sshCredentialManager } from "../core/ssh-credential-manager";
import { DomainError } from "../core/domain-error";
import { createFileExplorerRoutes } from "./file-explorer-routes";

const SSH_CREDENTIAL_TOKEN_HEADER = "x-clanky-ssh-credential-token";

function parseRef(req: Request, id: string): ExecutionHostRef {
  const segments = new URL(req.url).pathname.split("/");
  const kind = segments[3];
  if (kind === "local" || kind === "mesh") {
    return { kind, nodeId: id };
  }
  if (kind === "ssh") {
    return { kind, serverId: id };
  }
  throw new DomainError(
    "execution_host_kind_invalid",
    "Execution host kind must be local, mesh, or ssh.",
  );
}

async function resolveExecutionHostFileTarget(
  req: Request,
  id: string,
  startDirectory?: string,
  options?: { allowCredentialTokenQuery?: boolean },
): Promise<FileExplorerTarget> {
  const ref = parseRef(req, id);
  const descriptor = (await executionHostService.listHosts())
    .find((host) => executionHostRefsEqual(host.ref, ref));
  if (!descriptor) {
    throw new DomainError("execution_host_unavailable", "Execution host not found or unavailable.");
  }

  let sshPassword: string | undefined;
  if (ref.kind === "ssh") {
    const credentialToken = req.headers.get(SSH_CREDENTIAL_TOKEN_HEADER)?.trim()
      || (options?.allowCredentialTokenQuery
        ? new URL(req.url).searchParams.get("credentialToken")?.trim()
        : undefined);
    if (!credentialToken) {
      throw new DomainError(
        "invalid_credential_token",
        "SSH credential token is required for this execution host.",
      );
    }
    sshPassword = sshCredentialManager.getPasswordForToken(ref.serverId, credentialToken);
  }

  const defaultRoot = descriptor.repositoriesBasePath?.trim() || "/";
  const executor = await executionHostService.getCommandExecutorForRef(ref, {
    operationId: `file-explorer:${id}`,
    directory: defaultRoot,
    provider: "copilot",
    sshPassword,
  });
  return {
    id,
    rootDirectory: await resolveFileExplorerRootDirectory(
      executor,
      defaultRoot,
      startDirectory,
    ),
    pathScopeLabel: "active execution host explorer root",
    executor,
  };
}

export const executionHostFilesRoutes = createFileExplorerRoutes({
  basePath: "/api/execution-hosts/:kind/:id/files",
  logName: "execution-host-files",
  resourceLabel: "execution host",
  responseIdField: "serverId",
  invalidPathError: "invalid_server_path",
  internalError: "ssh_server_file_error",
  resolveTarget: resolveExecutionHostFileTarget,
});
