/**
 * Standalone SSH-server file explorer target adapter.
 */

import { DomainError } from "../core/domain-error";
import { sshCredentialManager } from "../core/ssh-credential-manager";
import {
  resolveFileExplorerRootDirectory,
  type FileExplorerTarget,
} from "../core/file-explorer-service";
import { sshServerManager } from "../core/ssh-server-manager";
import { createFileExplorerRoutes } from "./file-explorer-routes";

const SSH_CREDENTIAL_TOKEN_HEADER = "x-clanky-ssh-credential-token";

async function resolveSshServerFileTarget(
  req: Request,
  serverId: string,
  startDirectory?: string,
  options?: { allowCredentialTokenQuery?: boolean },
): Promise<FileExplorerTarget> {
  const credentialToken = req.headers.get(SSH_CREDENTIAL_TOKEN_HEADER)?.trim()
    || (options?.allowCredentialTokenQuery
      ? new URL(req.url).searchParams.get("credentialToken")?.trim()
      : undefined);
  if (!credentialToken) {
    throw new DomainError(
      "invalid_credential_token",
      "SSH credential token is required for standalone server file access",
    );
  }

  const server = await sshServerManager.getServer(serverId);
  if (!server) {
    throw new DomainError(
      "ssh_server_not_found",
      `SSH server not found: ${serverId}`,
      { details: { serverId } },
    );
  }

  const password = sshCredentialManager.getPasswordForToken(server.config.id, credentialToken);
  const connection = await sshServerManager.getCommandExecutor(server.config.id, password);
  const rootDirectory = await resolveFileExplorerRootDirectory(
    connection.executor,
    server.config.repositoriesBasePath?.trim() || "/",
    startDirectory,
  );

  return {
    id: server.config.id,
    rootDirectory,
    pathScopeLabel: "active server explorer root",
    executor: connection.executor,
  };
}

export const sshServerFilesRoutes = createFileExplorerRoutes({
  basePath: "/api/ssh-servers/:id/files",
  logName: "ssh-server-files",
  resourceLabel: "standalone SSH server",
  responseIdField: "serverId",
  invalidPathError: "invalid_server_path",
  internalError: "ssh_server_file_error",
  resolveTarget: resolveSshServerFileTarget,
});
