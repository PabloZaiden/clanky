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
import { sshServerKeyManager } from "./ssh-server-key-manager";
import { sshCredentialManager } from "./ssh-credential-manager";
import { CommandExecutorImpl } from "./remote-command-executor";
import type { SshConnectionTarget } from "./ssh-connection-target";
import { getSshConnectionTargetFromServer } from "./ssh-connection-target";
import { DomainError } from "./domain-error";

type SshServerExecutorFactory = (server: SshServerConfig, password: string) => CommandExecutor;

export class SshServerManager {
  private testExecutorFactory: SshServerExecutorFactory | null = null;

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
    await saveSshServerConfig(config);
    await sshServerKeyManager.ensurePublicKey(config.id);
    const server = await getSshServer(config.id);
    if (!server) {
      throw new DomainError(
        "ssh_server_reload_failed",
        "Failed to reload SSH server after creation",
        { details: { serverId: config.id } },
      );
    }
    return server;
  }

  async updateServer(id: string, request: UpdateSshServerRequest): Promise<SshServer> {
    const existing = await this.requireServerConfig(id);
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
  }

  async deleteServer(id: string): Promise<boolean> {
    sshCredentialManager.clearTokensForServer(id);
    return await deleteSshServer(id);
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

  setExecutorFactoryForTesting(factory: SshServerExecutorFactory | null): void {
    this.testExecutorFactory = factory;
  }

  private buildExecutor(server: SshServerConfig, password: string): CommandExecutor {
    if (this.testExecutorFactory) {
      return this.testExecutorFactory(server, password);
    }
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
