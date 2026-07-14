/**
 * ACP backend connection and chat session lifecycle.
 */

import {
  AcpBackend,
  createAcpSessionNotFoundError,
  getAcpErrorMessage,
  isAcpError,
  isAcpErrorCode,
} from "../backends/acp";
import type {
  Backend,
  BackendConnectionConfig,
  ImportableSession,
} from "../backends/types";
import type { Chat } from "@/shared";
import {
  SshCredentialsRequiredError,
  isSshServerChat,
} from "@/shared/chat";
import { createTimestamp } from "@/shared/events";
import type { AgentProvider } from "@/shared/settings";
import { backendManager, buildConnectionConfig } from "./backend";
import { sshCredentialManager } from "./ssh-credential-manager";
import { sshServerManager } from "./ssh-server-manager";
import { buildSshRemoteShellCommand } from "./remote-command-executor";
import { buildSshProcessConfig, getSshConnectionTargetFromServer } from "./ssh-connection-target";
import { buildProviderShellInvocation, getProviderAcpCommand } from "./agent-runtime-command";
import { createLogger } from "./logger";
import type {
  ChatSessionPort,
  ChatStatePort,
  ChatWorktreePort,
  ReconnectChatOptions,
} from "./chat-service-contracts";

const log = createLogger("chat-session-service");

export interface ChatSessionServiceDependencies {
  state: ChatStatePort;
  worktree: ChatWorktreePort;
  backendManager?: Pick<
    typeof backendManager,
    "getBackendAsync" | "getChatBackend" | "disconnectChat"
  >;
  sshCredentialManager?: Pick<typeof sshCredentialManager, "getPasswordForToken">;
  sshServerManager?: Pick<typeof sshServerManager, "getCommandExecutor">;
  hasActiveStream?: (chatId: string) => boolean;
}

export class ChatSessionService implements ChatSessionPort {
  private readonly state: ChatStatePort;
  private readonly worktree: ChatWorktreePort;
  private readonly backendManager: Pick<
    typeof backendManager,
    "getBackendAsync" | "getChatBackend" | "disconnectChat"
  >;
  private readonly sshCredentialManager: Pick<typeof sshCredentialManager, "getPasswordForToken">;
  private readonly sshServerManager: Pick<typeof sshServerManager, "getCommandExecutor">;
  private readonly hasActiveStream: (chatId: string) => boolean;
  private readonly sshChatBackends = new Map<string, Backend>();

  constructor(dependencies: ChatSessionServiceDependencies) {
    this.state = dependencies.state;
    this.worktree = dependencies.worktree;
    this.backendManager = dependencies.backendManager ?? backendManager;
    this.sshCredentialManager = dependencies.sshCredentialManager ?? sshCredentialManager;
    this.sshServerManager = dependencies.sshServerManager ?? sshServerManager;
    this.hasActiveStream = dependencies.hasActiveStream ?? (() => false);
  }

  getChatBackend(chatId: string, workspaceId: string): Backend {
    return this.backendManager.getChatBackend(chatId, workspaceId);
  }

  async getWorkspaceBackend(workspaceId: string, directory: string): Promise<Backend> {
    const workspace = await this.state.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    const backend = await this.backendManager.getBackendAsync(workspaceId);
    if (!backend.isConnected() || backend.getDirectory() !== directory) {
      if (backend.isConnected()) {
        await backend.disconnect();
      }
      await backend.connect(buildConnectionConfig(workspace.serverSettings, directory));
    }
    return backend;
  }

  async listImportableSessions(workspaceId: string): Promise<ImportableSession[]> {
    const workspace = await this.state.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    const backend = await this.getWorkspaceBackend(workspaceId, workspace.directory);
    return backend.listSessions(workspace.directory);
  }

  async ensureBackendConnected(chat: Chat, options: ReconnectChatOptions = {}): Promise<Backend> {
    if (isSshServerChat(chat)) {
      return this.ensureSshServerBackendConnected(chat, options);
    }

    const workspace = await this.state.getWorkspace(chat.config.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${chat.config.workspaceId}`);
    }

    const working = await this.worktree.resolveWorkingDirectory(chat, {
      prepareWorkspace: !this.worktree.hasEstablishedWorkspaceContext(chat),
    });
    await this.backendManager.getBackendAsync(chat.config.workspaceId);
    const backend = this.getChatBackend(working.chat.config.id, working.chat.config.workspaceId);
    if (!backend.isConnected() || backend.getDirectory() !== working.directory) {
      if (backend.isConnected()) {
        await backend.disconnect();
      }
      await backend.connect(buildConnectionConfig(workspace.serverSettings, working.directory));
    }
    return backend;
  }

  async ensureSession(
    chat: Chat,
    backend: Backend,
    options?: { recreateIfMissing?: boolean },
  ): Promise<Chat> {
    if (chat.state.session?.id) {
      try {
        const existing = await backend.getSession(chat.state.session.id);
        if (existing) {
          return chat;
        }
        if (options?.recreateIfMissing) {
          return this.recreateSession(chat, backend);
        }
        return this.failLostSession(chat, createAcpSessionNotFoundError(chat.state.session.id));
      } catch (error) {
        if (isAcpErrorCode(error, "acp_session_not_found")) {
          if (options?.recreateIfMissing) {
            return this.recreateSession(chat, backend);
          }
          return this.failLostSession(chat, error);
        }
        throw error;
      }
    }

    return this.createSession(chat, backend, {
      prepareWorkspace: !this.worktree.hasEstablishedWorkspaceContext(chat),
    });
  }

  async createSession(
    chat: Chat,
    backend: Backend,
    options: { prepareWorkspace: boolean },
  ): Promise<Chat> {
    const working = await this.worktree.resolveWorkingDirectory(chat, options);
    const session = await backend.createSession({
      title: `Clanky Chat: ${working.chat.config.name}`,
      directory: working.directory,
      model: working.chat.config.model.modelID,
    });

    await this.configureSessionModel(backend, session.id, working.chat.config.model.modelID);

    return this.state.updateState(working.chat, {
      ...working.chat.state,
      session: {
        id: session.id,
      },
      startedAt: working.chat.state.startedAt ?? createTimestamp(),
      lastActivityAt: createTimestamp(),
      error: undefined,
    });
  }

  async reconnectSession(chat: Chat, options: ReconnectChatOptions = {}): Promise<Chat> {
    const backend = await this.ensureBackendConnected(chat, options);
    let reconnectingChat = await this.state.updateState(chat, {
      ...chat.state,
      status: "reconnecting",
      error: undefined,
      lastActivityAt: createTimestamp(),
    });

    try {
      if (!reconnectingChat.state.session?.id) {
        reconnectingChat = await this.ensureSession(reconnectingChat, backend, { recreateIfMissing: true });
        return this.finishReconnect(reconnectingChat);
      }

      try {
        const existing = await backend.getSession(reconnectingChat.state.session.id);
        if (!existing) {
          reconnectingChat = await this.ensureSession(reconnectingChat, backend, { recreateIfMissing: true });
          return this.finishReconnect(reconnectingChat);
        }
      } catch (error) {
        if (!isAcpErrorCode(error, "acp_session_not_found")) {
          throw error;
        }
        reconnectingChat = await this.ensureSession(reconnectingChat, backend, { recreateIfMissing: true });
        return this.finishReconnect(reconnectingChat);
      }
    } catch (error) {
      await this.failChat(reconnectingChat, error);
      throw error;
    }

    return this.finishReconnect(reconnectingChat);
  }

  async disconnectChat(chatId: string): Promise<void> {
    const sshBackend = this.sshChatBackends.get(chatId);
    let sshDisconnectError: unknown;
    if (sshBackend) {
      try {
        sshBackend.abortAllSubscriptions();
        if (sshBackend.isConnected()) {
          await sshBackend.disconnect();
        }
      } catch (error) {
        sshDisconnectError = error;
        log.error("Failed to disconnect SSH chat backend", { chatId, error: String(error) });
      } finally {
        this.sshChatBackends.delete(chatId);
      }
    }
    await this.backendManager.disconnectChat(chatId);
    if (sshDisconnectError) {
      throw sshDisconnectError;
    }
  }

  async configureSessionModel(backend: Backend, sessionId: string, desiredModel: string): Promise<void> {
    try {
      await backend.setConfigOption(sessionId, "model", desiredModel);
      return;
    } catch {
      log.debug("Chat session config option not supported, trying setSessionModel", {
        sessionId,
        model: desiredModel,
      });
    }

    try {
      await backend.setSessionModel(sessionId, desiredModel);
    } catch (error) {
      log.warn("Failed to configure chat session model via ACP session controls", {
        sessionId,
        model: desiredModel,
        error: String(error),
      });
    }
  }

  async buildSshChatConnectionConfig(chat: Chat, password: string): Promise<BackendConnectionConfig> {
    const source = chat.config.source;
    if (source?.kind !== "ssh_server") {
      throw new Error(`Chat is not SSH-server backed: ${chat.config.id}`);
    }
    const provider = chat.config.model.providerID;
    if (
      provider !== "opencode"
      && provider !== "copilot"
      && provider !== "codex"
      && provider !== "claude"
      && provider !== "pi"
    ) {
      throw new Error(`Unsupported SSH chat provider: ${provider}`);
    }
    const providerCommand = getProviderAcpCommand(provider as AgentProvider, "ssh");
    const providerInvocation = buildProviderShellInvocation(providerCommand);
    const directory = source.directory || chat.config.directory;

    return {
      mode: "spawn",
      provider: provider as AgentProvider,
      transport: "ssh",
      directory,
      ...await this.buildSshChatProcessConfig(source.sshServerId, password, providerInvocation, directory),
    };
  }

  private getOrCreateSshChatBackend(chatId: string): Backend {
    const existing = this.sshChatBackends.get(chatId);
    if (existing) {
      return existing;
    }
    const backend = new AcpBackend();
    this.sshChatBackends.set(chatId, backend);
    return backend;
  }

  private async ensureSshServerBackendConnected(chat: Chat, options: ReconnectChatOptions): Promise<Backend> {
    const source = chat.config.source;
    if (source?.kind !== "ssh_server") {
      throw new Error(`Chat is not SSH-server backed: ${chat.config.id}`);
    }

    const backend = this.getOrCreateSshChatBackend(chat.config.id);
    const directory = source.directory || chat.config.directory;
    if (backend.isConnected() && backend.getDirectory() === directory) {
      return backend;
    }

    const credentialToken = options.credentialToken?.trim();
    if (!credentialToken) {
      await this.markSshCredentialsRequired(chat);
      throw new SshCredentialsRequiredError();
    }

    const connectingChat = await this.state.updateState(chat, {
      ...chat.state,
      connectionStatus: "connecting",
      lastActivityAt: createTimestamp(),
    });

    let password: string;
    try {
      password = this.sshCredentialManager.getPasswordForToken(source.sshServerId, credentialToken);
    } catch (error) {
      await this.markSshCredentialsRequired(connectingChat, String(error));
      throw new SshCredentialsRequiredError(String(error), {
        cause: error instanceof Error ? error : undefined,
      });
    }

    let config: BackendConnectionConfig;
    try {
      config = await this.buildSshChatConnectionConfig(connectingChat, password);
    } catch (error) {
      await this.markSshConnectionFailed(connectingChat, error);
      throw error;
    }

    if (backend.isConnected()) {
      await backend.disconnect();
    }

    try {
      await backend.connect(config);
      await this.state.updateState(connectingChat, {
        ...connectingChat.state,
        connectionStatus: "connected",
        lastActivityAt: createTimestamp(),
      });
      return backend;
    } catch (error) {
      await this.markSshConnectionFailed(connectingChat, error);
      throw error;
    }
  }

  private async markSshCredentialsRequired(
    chat: Chat,
    message = "SSH credentials are required to reconnect this chat",
  ): Promise<void> {
    await this.state.updateState(chat, {
      ...chat.state,
      connectionStatus: "needs_credentials",
      error: {
        message,
        timestamp: createTimestamp(),
        code: "ssh_credentials_required",
      },
      lastActivityAt: createTimestamp(),
    });
  }

  private async markSshConnectionFailed(chat: Chat, error: unknown): Promise<void> {
    await this.state.updateState(chat, {
      ...chat.state,
      connectionStatus: "ssh_connection_failed",
      error: {
        message: String(error),
        timestamp: createTimestamp(),
        code: "ssh_connection_failed",
      },
      lastActivityAt: createTimestamp(),
    });
  }

  private async buildSshChatProcessConfig(
    sshServerId: string,
    password: string,
    providerInvocation: string,
    directory: string,
  ): Promise<
    Pick<
      BackendConnectionConfig,
      "hostname" | "port" | "username" | "password" | "identityFile" | "command" | "args" | "env"
    >
  > {
    const { server } = await this.sshServerManager.getCommandExecutor(sshServerId, password);
    const target = getSshConnectionTargetFromServer(server, password);
    const processConfig = buildSshProcessConfig({
      target,
      remoteCommand: buildSshRemoteShellCommand(providerInvocation),
      connectionScope: directory,
      passwordHandling: "environment",
    });
    return {
      hostname: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      identityFile: target.identityFile,
      command: processConfig.command,
      args: processConfig.args,
      env: processConfig.env,
    };
  }

  private async recreateSession(chat: Chat, backend: Backend): Promise<Chat> {
    const reconnecting = chat.state.status === "reconnecting"
      ? chat
      : await this.state.updateState(chat, {
          ...chat.state,
          status: "reconnecting",
          error: undefined,
          completedAt: undefined,
          activeMessageId: undefined,
          interruptRequested: false,
          lastActivityAt: createTimestamp(),
        });
    try {
      return await this.createSession(reconnecting, backend, { prepareWorkspace: false });
    } catch (error) {
      await this.failChat(reconnecting, error);
      throw error;
    }
  }

  private async failLostSession(chat: Chat, error: unknown): Promise<Chat> {
    return this.failChat(chat, error);
  }

  private async failChat(chat: Chat, error: unknown): Promise<Chat> {
    const message = typeof error === "string" ? error : getAcpErrorMessage(error);
    const errorCode = isAcpError(error) ? error.code : undefined;
    log.error("Chat runtime error", { chatId: chat.config.id, error: message });
    return this.state.markChatError(chat, message, errorCode);
  }

  private async finishReconnect(chat: Chat): Promise<Chat> {
    const status = this.hasActiveStream(chat.config.id) ? "streaming" : "idle";
    const state: Chat["state"] = {
      ...chat.state,
      status,
      error: undefined,
      connectionStatus: isSshServerChat(chat) ? "connected" : chat.state.connectionStatus,
      lastActivityAt: createTimestamp(),
    };
    return this.state.updateState(chat, state);
  }
}
