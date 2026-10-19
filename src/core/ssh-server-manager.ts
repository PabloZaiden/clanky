/**
 * Core manager for registered SSH execution hosts and browser-owned credentials.
 */

import { type SshServer, type SshServerConfig } from "@/shared";
import {
  type CreateSshServerRequest,
  type UpdateSshServerRequest,
} from "@/contracts";
import type { CommandExecutor } from "./command-executor";
import {
  deleteSshServer,
  getSshServer,
  getSshServerConfig,
  listSshServers,
  saveSshServerConfig,
} from "../persistence/ssh-servers";
import { generateSshServerKeyPair, sshServerKeyManager } from "./ssh-server-key-manager";
import { deleteSshServerKeyPair, saveSshServerKeyPair } from "../persistence/ssh-server-keys";
import { withSshServerOperation } from "./ssh-server-operations";
import { sshCredentialManager } from "./ssh-credential-manager";
import { CommandExecutorImpl } from "./remote-command-executor";
import type { SshConnectionTarget } from "./ssh-connection-target";
import { getSshConnectionTargetFromServer } from "./ssh-connection-target";
import { DomainError } from "../domain/domain-error";

export class SshServerManager {
  async listServers(): Promise<SshServer[]> {
    return await listSshServers();
  }

  async getServer(id: string): Promise<SshServer | null> {
    return await getSshServer(id);
  }

  async createServer(request: CreateSshServerRequest): Promise<SshServer> {
    const now = new Date().toISOString();
    const config: SshServerConfig = {
      id: crypto.randomUUID(),
      name: request.name.trim(),
      address: request.address.trim(),
      port: request.port ?? 22,
      username: request.username.trim(),
      repositoriesBasePath: request.repositoriesBasePath?.trim() || null,
      createdAt: now,
      updatedAt: now,
    };
    return await withSshServerOperation(config.id, async () => {
      const keyPair = await generateSshServerKeyPair(1);
      try {
        await saveSshServerKeyPair(config.id, keyPair);
        await saveSshServerConfig(config);
      } catch (error) {
        try {
          await deleteSshServerKeyPair(config.id);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "SSH server registration and key cleanup failed.");
        }
        throw error;
      }
      const server = await getSshServer(config.id);
      if (!server) {
        throw new DomainError(
          "ssh_server_reload_failed",
          "Failed to reload SSH server after creation",
          { details: { serverId: config.id } },
        );
      }
      return server;
    });
  }

  async updateServer(id: string, request: UpdateSshServerRequest): Promise<SshServer> {
    await sshServerKeyManager.ensurePublicKey(id);
    return await withSshServerOperation(id, async () => {
      const existing = await this.requireServerConfig(id);
      if ((request.address !== undefined && request.address.trim() !== existing.address)
        || (request.port !== undefined && request.port !== existing.port)
        || (request.username !== undefined && request.username.trim() !== existing.username)) {
        const { previewSessionManager } = await import("./preview-session-manager");
        await previewSessionManager.closeSshServerPreviews(id);
      }
      await saveSshServerConfig({
        ...existing,
        ...(request.name !== undefined ? { name: request.name.trim() } : {}),
        ...(request.address !== undefined ? { address: request.address.trim() } : {}),
        ...(request.port !== undefined ? { port: request.port } : {}),
        ...(request.username !== undefined ? { username: request.username.trim() } : {}),
        ...(request.repositoriesBasePath !== undefined
          ? { repositoriesBasePath: request.repositoriesBasePath?.trim() || null }
          : {}),
        ...(request.isPrivate !== undefined ? { isPrivate: request.isPrivate } : {}),
        updatedAt: new Date().toISOString(),
      });
      const updated = await getSshServer(id);
      if (!updated) {
        throw new DomainError(
          "ssh_server_reload_failed",
          "Failed to reload SSH server after update",
          { details: { serverId: id } },
        );
      }
      return updated;
    });
  }

  async deleteServer(id: string): Promise<boolean> {
    return await withSshServerOperation(id, async () => {
      const { previewSessionManager } = await import("./preview-session-manager");
      await previewSessionManager.closeSshServerPreviews(id);
      sshCredentialManager.clearTokensForServer(id);
      return await deleteSshServer(id);
    });
  }

  async getCommandExecutor(
    serverId: string,
    password?: string,
  ): Promise<{ server: SshServerConfig; executor: CommandExecutor }> {
    const server = await this.requireServerConfig(serverId);
    return {
      server,
      executor: this.buildExecutor(server, password ?? ""),
    };
  }

  async getExecutionHostTerminalConnection(
    serverId: string,
    credentialToken: string,
  ): Promise<{ server: SshServerConfig; target: SshConnectionTarget; executor: CommandExecutor }> {
    const server = await this.requireServerConfig(serverId);
    const trimmedToken = credentialToken.trim();
    if (!trimmedToken) {
      throw new DomainError(
        "invalid_credential_token",
        "SSH credential token is required for direct terminal connections",
      );
    }
    const password = sshCredentialManager.getPasswordForToken(server.id, trimmedToken);
    return {
      server,
      target: getSshConnectionTargetFromServer(server, password),
      executor: this.buildExecutor(server, password),
    };
  }

  private buildExecutor(server: SshServerConfig, password: string): CommandExecutor {
    const sshTarget = getSshConnectionTargetFromServer(server, password);
    return new CommandExecutorImpl({
      provider: "ssh",
      directory: "/",
      host: sshTarget.host,
      port: sshTarget.port,
      user: sshTarget.username,
      password: sshTarget.password,
      identityFile: sshTarget.identityFile,
    });
  }

  private async requireServerConfig(id: string): Promise<SshServerConfig> {
    const server = await getSshServerConfig(id);
    if (!server) {
      throw new DomainError("ssh_server_not_found", "SSH server not found", {
        details: { serverId: id },
      });
    }
    return server;
  }

}

export const sshServerManager = new SshServerManager();
