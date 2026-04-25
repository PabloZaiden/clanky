/**
 * Core manager for standalone SSH servers and server-owned SSH sessions.
 */

import {
  DEFAULT_SSH_CONNECTION_MODE,
  DEFAULT_SSH_SESSION_USE_TMUX,
  type CreateSshServerRequest,
  type CreateSshServerSessionRequest,
  type CheckSshServerPrerequisitesRequest,
  type DevboxTemplateSummary,
  type GetDevboxTemplatesRequest,
  type DeleteSshServerSessionRequest,
  type SshConnectionMode,
  type SshServer,
  type SshServerConfig,
  type SshServerPrerequisiteReport,
  type SshSessionStatus,
  type SshServerSession,
  type UpdateSshServerRequest,
  type UpdateSshSessionRequest,
} from "../types";
import type { CommandExecutor } from "./command-executor";
import {
  countSshServerSessionsByServerId,
  deleteSshServer,
  deleteSshServerSession,
  getSshServer,
  getSshServerConfig,
  getSshServerSession,
  listSshServerSessionsByServerId,
  listSshServers,
  saveSshServerConfig,
  saveSshServerSession,
} from "../persistence/ssh-servers";
import { buildDefaultSshSessionName } from "../utils";
import { isPersistentSshSession } from "../utils";
import { sshServerKeyManager } from "./ssh-server-key-manager";
import { sshCredentialManager } from "./ssh-credential-manager";
import { CommandExecutorImpl } from "./remote-command-executor";
import { sshSessionEventEmitter } from "./event-emitter";
import type { SshConnectionTarget } from "./ssh-connection-target";
import { getSshConnectionTargetFromServer } from "./ssh-connection-target";
import { buildPersistentSessionDeleteCommand } from "./ssh-persistent-session";
import { checkSshServerPrerequisites } from "./ssh-server-prerequisites";
import { parseDevboxTemplatesOutput } from "./ssh-server-devbox-templates";

type SshServerExecutorFactory = (server: SshServerConfig, password: string) => CommandExecutor;

function buildRemoteSessionName(id: string): string {
  return `ralpher-${id.replace(/-/g, "").slice(0, 24)}`;
}

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
      username: request.username.trim(),
      repositoriesBasePath: request.repositoriesBasePath?.trim() || null,
      createdAt: now,
      updatedAt: now,
    };
    await saveSshServerConfig(config);
    await sshServerKeyManager.ensurePublicKey(config.id);
    const server = await getSshServer(config.id);
    if (!server) {
      throw new Error(`Failed to reload SSH server after creation: ${config.id}`);
    }
    return server;
  }

  async updateServer(id: string, request: UpdateSshServerRequest): Promise<SshServer> {
    const existing = await this.requireServerConfig(id);
    await saveSshServerConfig({
      ...existing,
      ...(request.name !== undefined ? { name: request.name.trim() } : {}),
      ...(request.address !== undefined ? { address: request.address.trim() } : {}),
      ...(request.username !== undefined ? { username: request.username.trim() } : {}),
      ...(request.repositoriesBasePath !== undefined
        ? { repositoriesBasePath: request.repositoriesBasePath?.trim() || null }
        : {}),
      updatedAt: new Date().toISOString(),
    });
    const updated = await getSshServer(id);
    if (!updated) {
      throw new Error(`Failed to reload SSH server after update: ${id}`);
    }
    return updated;
  }

  async deleteServer(id: string): Promise<boolean> {
    sshCredentialManager.clearTokensForServer(id);
    return await deleteSshServer(id);
  }

  async listSessions(serverId: string): Promise<SshServerSession[]> {
    await this.requireServerConfig(serverId);
    return await listSshServerSessionsByServerId(serverId);
  }

  async getSession(id: string): Promise<SshServerSession | null> {
    return await getSshServerSession(id);
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

  async checkPrerequisites(
    serverId: string,
    request: CheckSshServerPrerequisitesRequest = { credentialToken: null },
  ): Promise<SshServerPrerequisiteReport> {
    const server = await this.requireServerConfig(serverId);
    const credentialToken = request.credentialToken?.trim();
    const password = credentialToken
      ? sshCredentialManager.getPasswordForToken(server.id, credentialToken)
      : undefined;
    return await checkSshServerPrerequisites(server, this.buildExecutor(server, password ?? ""));
  }

  async listDevboxTemplates(
    serverId: string,
    request: GetDevboxTemplatesRequest = { credentialToken: null },
  ): Promise<DevboxTemplateSummary[]> {
    const server = await this.requireServerConfig(serverId);
    const credentialToken = request.credentialToken?.trim();
    const password = credentialToken
      ? sshCredentialManager.getPasswordForToken(server.id, credentialToken)
      : undefined;
    const executor = this.buildExecutor(server, password ?? "");
    const result = await executor.exec("devbox", ["templates"], { cwd: "/" });
    if (!result.success) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "Failed to list devbox templates");
    }
    return parseDevboxTemplatesOutput(result.stdout);
  }

  async createSession(serverId: string, request: CreateSshServerSessionRequest): Promise<SshServerSession> {
    const server = await this.requireServerConfig(serverId);
    const connectionMode = this.getConnectionMode(request);
    const useTmux = request.useTmux ?? DEFAULT_SSH_SESSION_USE_TMUX;

    const now = new Date().toISOString();
    const sessionCount = await countSshServerSessionsByServerId(serverId);
    const sessionId = crypto.randomUUID();
    const session: SshServerSession = {
      config: {
        id: sessionId,
        sshServerId: serverId,
        name: request.name?.trim() || buildDefaultSshSessionName(server.name, sessionCount),
        connectionMode,
        useTmux,
        remoteSessionName: buildRemoteSessionName(sessionId),
        createdAt: now,
        updatedAt: now,
      },
      state: {
        status: "ready",
      },
    };
    await saveSshServerSession(session);
    sshSessionEventEmitter.emit({
      type: "ssh_session.status",
      sshSessionId: session.config.id,
      status: session.state.status,
      error: session.state.error,
      timestamp: session.config.updatedAt,
    });
    return session;
  }

  async updateSession(id: string, request: UpdateSshSessionRequest): Promise<SshServerSession> {
    const session = await this.requireSession(id);
    const updated: SshServerSession = {
      config: {
        ...session.config,
        name: request.name.trim(),
        updatedAt: new Date().toISOString(),
      },
      state: session.state,
    };
    await saveSshServerSession(updated);
    return updated;
  }

  async deleteSession(id: string, request: DeleteSshServerSessionRequest): Promise<boolean> {
    const session = await this.requireSession(id);
    if (isPersistentSshSession(session)) {
      const server = await this.requireServerConfig(session.config.sshServerId);
      const credentialToken = request.credentialToken?.trim();
      if (!credentialToken) {
        throw new Error("SSH credential token is required to delete persistent standalone SSH sessions");
      }
      const password = sshCredentialManager.getPasswordForToken(server.id, credentialToken);
      const executor = this.buildExecutor(server, password);
      const result = await executor.exec("bash", ["-lc", buildPersistentSessionDeleteCommand(session)], {
        cwd: "/",
      });
      if (!result.success) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || "Failed to stop remote persistent SSH session");
      }
    }
    return await deleteSshServerSession(id);
  }

  async getTerminalConnection(
    sessionId: string,
    credentialToken: string,
  ): Promise<{ session: SshServerSession; server: SshServerConfig; target: SshConnectionTarget; executor: CommandExecutor }> {
    const session = await this.requireSession(sessionId);
    const server = await this.requireServerConfig(session.config.sshServerId);
    const trimmedToken = credentialToken.trim();
    if (!trimmedToken) {
      throw new Error("SSH credential token is required for standalone terminal connections");
    }
    const password = sshCredentialManager.getPasswordForToken(server.id, trimmedToken);
    const target = getSshConnectionTargetFromServer(server, password);
    return {
      session,
      server,
      target,
      executor: this.buildExecutor(server, password),
    };
  }

  async markStatus(id: string, status: SshSessionStatus, error?: string): Promise<SshServerSession> {
    const session = await this.requireSession(id);
    const updatedSession: SshServerSession = {
      config: {
        ...session.config,
        updatedAt: new Date().toISOString(),
      },
      state: {
        ...session.state,
        status,
        error: error?.trim() || undefined,
        lastConnectedAt: status === "connected"
          ? new Date().toISOString()
          : session.state.lastConnectedAt,
      },
    };
    await saveSshServerSession(updatedSession);
    sshSessionEventEmitter.emit({
      type: "ssh_session.status",
      sshSessionId: id,
      status,
      error: updatedSession.state.error,
      timestamp: updatedSession.config.updatedAt,
    });
    return updatedSession;
  }

  async updateRuntimeConnectionState(
    id: string,
    options: { runtimeConnectionMode?: SshConnectionMode; notice?: string },
  ): Promise<SshServerSession> {
    const session = await this.requireSession(id);
    const updatedSession: SshServerSession = {
      config: {
        ...session.config,
        updatedAt: new Date().toISOString(),
      },
      state: {
        ...session.state,
        runtimeConnectionMode: options.runtimeConnectionMode,
        notice: options.notice?.trim() || undefined,
      },
    };
    await saveSshServerSession(updatedSession);
    sshSessionEventEmitter.emit({
      type: "ssh_session.status",
      sshSessionId: updatedSession.config.id,
      status: updatedSession.state.status,
      error: updatedSession.state.error,
      timestamp: updatedSession.config.updatedAt,
    });
    return updatedSession;
  }

  setExecutorFactoryForTesting(factory: SshServerExecutorFactory | null): void {
    this.testExecutorFactory = factory;
  }

  private getConnectionMode(request: { connectionMode?: SshConnectionMode }): SshConnectionMode {
    return request.connectionMode ?? DEFAULT_SSH_CONNECTION_MODE;
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
      throw new Error(`SSH server not found: ${id}`);
    }
    return server;
  }

  private async requireSession(id: string): Promise<SshServerSession> {
    const session = await getSshServerSession(id);
    if (!session) {
      throw new Error(`SSH server session not found: ${id}`);
    }
    return session;
  }
}

export const sshServerManager = new SshServerManager();
