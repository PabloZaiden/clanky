/**
 * ACP backend connection and chat session lifecycle.
 */

import {
  createAcpSessionNotFoundError,
  getAcpErrorMessage,
  isAcpError,
  isAcpErrorCode,
} from "../backends/acp";
import type {
  Backend,
  ImportableSession,
} from "../backends/types";
import type { Chat } from "@/shared";
import {
  SshCredentialsRequiredError,
  getChatWorkspaceId,
  isExecutionHostChat,
} from "@/shared/chat";
import { createTimestamp } from "@/shared/events";
import type { AgentProvider } from "@/shared/settings";
import { getRegisteredSshServerId } from "@/shared/execution-host";
import { backendManager, buildConnectionConfig } from "./backend";
import { sshCredentialManager } from "./ssh-credential-manager";
import { managedContextIdentityResolver } from "./managed-context-identity";
import { managedCredentialService } from "./managed-credential-service";
import { buildManagedContextEnvironment } from "./managed-context-environment";
import { createLogger } from "@pablozaiden/webapp/server";
import type {
  ChatSessionPort,
  ChatStatePort,
  ChatDirectoryResolution,
  ChatWorktreePort,
  ReconnectChatOptions,
} from "./chat-service-contracts";

const log = createLogger("chat-session-service");

export interface ChatSessionServiceDependencies {
  state: ChatStatePort;
  worktree: ChatWorktreePort;
  backendManager?: Pick<
    typeof backendManager,
    "getBackendAsync" | "getChatBackend" | "disconnectChat" | "createBackendForExecutionHost" | "getWorkspaceSettings"
  >;
  sshCredentialManager?: Pick<typeof sshCredentialManager, "getPasswordForToken">;
  hasActiveStream?: (chatId: string) => boolean;
}

export class ChatSessionService implements ChatSessionPort {
  private readonly state: ChatStatePort;
  private readonly worktree: ChatWorktreePort;
  private readonly backendManager: Pick<
    typeof backendManager,
    "getBackendAsync" | "getChatBackend" | "disconnectChat" | "createBackendForExecutionHost" | "getWorkspaceSettings"
  >;
  private readonly sshCredentialManager: Pick<typeof sshCredentialManager, "getPasswordForToken">;
  private readonly hasActiveStream: (chatId: string) => boolean;
  private readonly directChatBackends = new Map<string, Backend>();

  constructor(dependencies: ChatSessionServiceDependencies) {
    this.state = dependencies.state;
    this.worktree = dependencies.worktree;
    this.backendManager = dependencies.backendManager ?? backendManager;
    this.sshCredentialManager = dependencies.sshCredentialManager ?? sshCredentialManager;
    this.hasActiveStream = dependencies.hasActiveStream ?? (() => false);
  }

  getChatBackend(chatId: string, workspaceId?: string): Backend {
    const directBackend = this.directChatBackends.get(chatId);
    if (directBackend) {
      return directBackend;
    }
    if (!workspaceId) {
      throw new Error(`Workspace-backed chat is missing workspaceId: ${chatId}`);
    }
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
      const settings = await this.backendManager.getWorkspaceSettings(workspaceId);
      await backend.connect(buildConnectionConfig(settings, directory));
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

  async ensureBackendConnected(
    chat: Chat,
    options: ReconnectChatOptions = {},
    workingDirectory?: ChatDirectoryResolution,
  ): Promise<Backend> {
    if (isExecutionHostChat(chat)) {
      await this.state.updateStartupStage(chat, "connecting_provider", {
        expectedStatus: chat.state.status,
      });
      return await this.ensureExecutionHostBackendConnected(chat, options);
    }
    const workspaceId = getChatWorkspaceId(chat);
    const workspace = await this.state.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${chat.config.workspaceId}`);
    }

    const working = workingDirectory ?? await this.worktree.resolveWorkingDirectory(chat, {
      prepareWorkspace: !this.worktree.hasEstablishedWorkspaceContext(chat),
      signal: options.signal,
    });
    const stagedWorking = workingDirectory
      ? working
      : {
          ...working,
          chat: await this.state.updateStartupStage(working.chat, "connecting_provider", {
            expectedStatus: working.chat.state.status,
          }),
        };
    await this.backendManager.getBackendAsync(workspaceId);
    const backend = this.getChatBackend(stagedWorking.chat.config.id, workspaceId);
    if (!backend.isConnected() || backend.getDirectory() !== stagedWorking.directory) {
      if (backend.isConnected()) {
        await backend.disconnect();
      }
      const identity = await managedContextIdentityResolver.forChat(
        stagedWorking.chat.config.id,
        workspaceId,
      );
      const credential = await managedCredentialService.ensureCredentialForRuntime(
        identity,
        working.chat.state.session?.id ? "recreate" : "reuse",
      );
      try {
        await backend.connect(buildConnectionConfig(
          await this.backendManager.getWorkspaceSettings(workspaceId),
          stagedWorking.directory,
          buildManagedContextEnvironment(credential),
        ), options.signal);
      } catch (error) {
        await managedCredentialService.cleanupFailedLaunch(credential, error);
        throw error;
      }
    }

    return backend;
  }

  async ensureSession(
    chat: Chat,
    backend: Backend,
    options?: {
      recreateIfMissing?: boolean;
      workingDirectory?: ChatDirectoryResolution;
      signal?: AbortSignal;
    },
  ): Promise<Chat> {
    throwIfAborted(options?.signal);
    if (chat.state.session?.id) {
      try {
        const existing = await raceWithAbort(
          backend.getSession(chat.state.session.id),
          options?.signal,
        );
        throwIfAborted(options?.signal);
        if (existing) {
          return chat;
        }
        if (options?.recreateIfMissing) {
          return this.recreateSession(chat, backend, options);
        }
        return this.failLostSession(chat, createAcpSessionNotFoundError(chat.state.session.id));
      } catch (error) {
        if (isAcpErrorCode(error, "acp_session_not_found")) {
          if (options?.recreateIfMissing) {
            return this.recreateSession(chat, backend, options);
          }
          return this.failLostSession(chat, error);
        }
        throw error;
      }
    }

    return this.createSession(chat, backend, {
      prepareWorkspace: !this.worktree.hasEstablishedWorkspaceContext(chat),
      workingDirectory: options?.workingDirectory,
      signal: options?.signal,
    });
  }

  async createSession(
    chat: Chat,
    backend: Backend,
    options: {
      prepareWorkspace: boolean;
      workingDirectory?: ChatDirectoryResolution;
      signal?: AbortSignal;
    },
  ): Promise<Chat> {
    throwIfAborted(options.signal);
    const working = options.workingDirectory
      ? { ...options.workingDirectory, chat }
      : await this.worktree.resolveWorkingDirectory(chat, options);
    const stagedWorking = {
      ...working,
      chat: await this.state.updateStartupStage(working.chat, "creating_session", {
        expectedStatus: working.chat.state.status,
      }),
    };
    throwIfAborted(options.signal);
    const sessionPromise = backend.createSession({
      title: `Clanky Chat: ${stagedWorking.chat.config.name}`,
      directory: stagedWorking.directory,
      model: stagedWorking.chat.config.model.modelID,
    });
    let session: Awaited<typeof sessionPromise>;
    try {
      session = await raceWithAbort(sessionPromise, options.signal);
    } catch (error) {
      if (options.signal) {
        void sessionPromise.then(async (lateSession) => {
          if (!options.signal?.aborted) {
            return;
          }
          try {
            await withTimeout(
              backend.deleteSession(lateSession.id),
              5_000,
              `Timed out deleting cancelled chat session ${lateSession.id}`,
            );
          } catch (cleanupError) {
            log.warn("Failed to clean up a chat session created after cancellation", {
              chatId: chat.config.id,
              sessionId: lateSession.id,
              error: String(cleanupError),
            });
          }
        }).catch((lateError) => {
          log.debug("Cancelled chat session creation rejected after cancellation", {
            chatId: chat.config.id,
            error: String(lateError),
          });
        });
      }
      throw error;
    }
    throwIfAborted(options.signal);

    return this.state.updateState(stagedWorking.chat, {
      ...stagedWorking.chat.state,
      session: {
        id: session.id,
      },
      startedAt: stagedWorking.chat.state.startedAt ?? createTimestamp(),
      lastActivityAt: createTimestamp(),
      error: undefined,
    }, {
      expectedStatus: options.signal ? stagedWorking.chat.state.status : undefined,
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
        reconnectingChat = await this.ensureSession(reconnectingChat, backend, {
          recreateIfMissing: true,
          signal: options.signal,
        });
        return this.finishReconnect(reconnectingChat);
      }

      try {
        const existing = await backend.getSession(reconnectingChat.state.session.id);
        if (!existing) {
          reconnectingChat = await this.ensureSession(reconnectingChat, backend, {
            recreateIfMissing: true,
            signal: options.signal,
          });
          return this.finishReconnect(reconnectingChat);
        }
      } catch (error) {
        if (!isAcpErrorCode(error, "acp_session_not_found")) {
          throw error;
        }
        reconnectingChat = await this.ensureSession(reconnectingChat, backend, {
          recreateIfMissing: true,
          signal: options.signal,
        });
        return this.finishReconnect(reconnectingChat);
      }
    } catch (error) {
      await this.failChat(reconnectingChat, error);
      throw error;
    }

    return this.finishReconnect(reconnectingChat);
  }

  async disconnectChat(chatId: string): Promise<void> {
    const sshBackend = this.directChatBackends.get(chatId);
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
        this.directChatBackends.delete(chatId);
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
    } catch (error) {
      if (!isAcpErrorCode(error, "acp_method_not_found")) {
        log.warn("Failed to configure chat session model via ACP config option", {
          sessionId,
          model: desiredModel,
          error: String(error),
        });
        return;
      }
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

  private async ensureExecutionHostBackendConnected(
    chat: Chat,
    options: ReconnectChatOptions,
  ): Promise<Backend> {
    const source = chat.config.source;
    if (source?.kind !== "execution_host") {
      throw new Error(`Chat is not execution-host backed: ${chat.config.id}`);
    }
    const directory = source.directory || chat.config.directory;
    const existing = this.directChatBackends.get(chat.config.id);
    if (existing?.isConnected() && existing.getDirectory() === directory) {
      return existing;
    }
    if (existing?.isConnected()) {
      await existing.disconnect();
    }

    let password: string | undefined;
    if (source.executionHost.host.kind === "ssh") {
      const serverId = getRegisteredSshServerId(source.executionHost.host);
      if (serverId) {
        const credentialToken = options.credentialToken?.trim();
        if (!credentialToken) {
          await this.markSshCredentialsRequired(chat);
          throw new SshCredentialsRequiredError();
        }
        password = this.sshCredentialManager.getPasswordForToken(
          serverId,
          credentialToken,
        );
      }
    }

    try {
      const { backend, settings } = await this.backendManager.createBackendForExecutionHost(
        chat.config.id,
        source.executionHost,
        chat.config.model.providerID as AgentProvider,
        password,
      );
      this.directChatBackends.set(chat.config.id, backend);
      await backend.connect(buildConnectionConfig(settings, directory), options.signal);
      return backend;
    } catch (error) {
      if (
        source.executionHost.host.kind === "ssh"
        && !options.signal?.aborted
        && !isAcpErrorCode(error, "acp_connection_aborted")
        && !isAcpErrorCode(error, "acp_request_cancelled")
      ) {
        await this.markSshConnectionFailed(chat, error);
      }
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

  private async recreateSession(
    chat: Chat,
    backend: Backend,
    options: {
      workingDirectory?: ChatDirectoryResolution;
      signal?: AbortSignal;
    } = {},
  ): Promise<Chat> {
    throwIfAborted(options.signal);
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
          }, {
            expectedStatus: options.signal ? chat.state.status : undefined,
          });
    try {
      return await this.createSession(reconnecting, backend, {
          prepareWorkspace: false,
          workingDirectory: options.workingDirectory,
          signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) {
          throw error;
      }
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
      connectionStatus: isExecutionHostChat(chat)
        ? "connected"
        : chat.state.connectionStatus,
      startupStage: undefined,
      lastActivityAt: createTimestamp(),
    };
    return this.state.updateState(chat, state);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Chat startup was aborted.");
  }
}

async function raceWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return await operation;
  }
  throwIfAborted(signal);
  let abortHandler: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    abortHandler = () => reject(
      signal.reason instanceof Error
        ? signal.reason
        : new Error("Chat startup was aborted."),
    );
    signal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    return await Promise.race([operation, abortPromise]);
  } finally {
    if (abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
