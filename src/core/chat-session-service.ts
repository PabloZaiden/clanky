/**
 * Harness backend connection and chat session lifecycle.
 */

import type {
  Backend,
} from "../backends/types";
import type { Chat } from "@/shared";
import {
  getChatWorkspaceId,
  isExecutionHostChat,
  hasRemoteChatContinuity,
} from "@/shared/chat";
import { createTimestamp } from "@/shared/events";
import { executionHostBindingsEqual } from "@/shared/execution-host";
import { createAgentSettings } from "@/shared/settings";
import { backendManager, buildConnectionConfig } from "./backend";
import { sshKeyAccessService } from "./ssh-key-access-service";
import { managedContextIdentityResolver } from "./managed-context-identity";
import { createExecutionControlConnection } from "./control-tool-transport";
import { createLogger } from "@pablozaiden/webapp/server";
import { requireExecutionOwnerUserId } from "../context/user-context";
import { createOwnedHarnessSession, resumeOwnedHarnessSession } from "./harness-session";
import { HarnessError } from "../backends/harness-errors";
import { harnessActivityService } from "./harness-activity-service";
import { DomainError, isDomainError } from "../domain/domain-error";
import type { HarnessCapabilities, HarnessConversationBinding } from "@/shared/harness-control";
import type { HarnessEvent } from "@/shared/harness-events";
import { closeOpenQuestions, isQuestionOpen } from "@/shared/harness-questions";
import { isAutomationCodeEnabled } from "@/shared/automation";
import { loadAutomationRunSummaryByChatId } from "../persistence/automations";
import { isClankyControlChat } from "@/shared/clanky-control";
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
    "getBackendAsync" | "getChatBackend" | "getInitializedContextBackend" | "disconnectChat" | "createBackendForExecutionHost" | "getConnectedExecutionHostBackend" | "getWorkspaceSettings"
  >;
  hasActiveStream?: (chatId: string) => boolean;
  onHarnessEvent?: (chatId: string, binding: HarnessConversationBinding, event: HarnessEvent) => Promise<void>;
  onNativeSession?: (chat: Chat, backend: Backend, binding: HarnessConversationBinding, recover: boolean | "live") => Promise<void>;
  onNativeDisconnect?: (chatId: string) => Promise<void>;
}

export class ChatSessionService implements ChatSessionPort {
  private readonly state: ChatStatePort;
  private readonly worktree: ChatWorktreePort;
  private readonly backendManager: Pick<
    typeof backendManager,
    "getBackendAsync" | "getChatBackend" | "getInitializedContextBackend" | "disconnectChat" | "createBackendForExecutionHost" | "getConnectedExecutionHostBackend" | "getWorkspaceSettings"
  >;
  private readonly hasActiveStream: (chatId: string) => boolean;
  private readonly directChatBackends = new Map<string, Backend>();
  private readonly connectedControlStates = new WeakMap<Backend, boolean>();
  private readonly onHarnessEvent: ChatSessionServiceDependencies["onHarnessEvent"];
  private readonly onNativeSession: ChatSessionServiceDependencies["onNativeSession"];
  private readonly onNativeDisconnect: ChatSessionServiceDependencies["onNativeDisconnect"];

  constructor(dependencies: ChatSessionServiceDependencies) {
    this.state = dependencies.state;
    this.worktree = dependencies.worktree;
    this.backendManager = dependencies.backendManager ?? backendManager;
    this.hasActiveStream = dependencies.hasActiveStream ?? (() => false);
    this.onHarnessEvent = dependencies.onHarnessEvent;
    this.onNativeSession = dependencies.onNativeSession;
    this.onNativeDisconnect = dependencies.onNativeDisconnect;
  }

  async getChatAdapter(chat: Chat): Promise<HarnessCapabilities["adapter"]> {
    if (isExecutionHostChat(chat)) {
      const source = chat.config.source;
      if (source?.kind !== "execution_host" || !source.adapter) {
        throw new HarnessError("harness_model_not_available", "The selected execution-host adapter is unavailable.");
      }
      return source.adapter;
    }
    const backend = await this.backendManager.getBackendAsync(getChatWorkspaceId(chat));
    return backend.harness.capabilities.adapter;
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

  async getActivity(chatId: string) {
    const chat = await this.state.getChatSummary(chatId);
    if (!chat) throw new HarnessError("harness_session_not_found", "The chat is unavailable.");
    const backend = this.directChatBackends.get(chatId) ?? this.backendManager.getInitializedContextBackend(chatId);
    if (backend?.harness.capabilities.activity === "unavailable") return { observation: "unavailable" as const, reason: "unsupported" as const };
    if (!backend?.isConnected()) return { observation: "unavailable" as const, reason: "disconnected" as const };
    const binding = chat.state.session?.binding;
    if (!binding) throw new HarnessError("harness_session_not_owned", "Activity requires an owned conversation.");
    return harnessActivityService.getActivity({ kind: "chat", id: chatId }, binding, backend);
  }

  async stopActivity(chatId: string, activityId: string) {
    const chat = await this.state.getChatSummary(chatId);
    if (!chat) throw new HarnessError("harness_session_not_found", "The chat is unavailable.");
    const backend = this.directChatBackends.get(chatId) ?? this.backendManager.getInitializedContextBackend(chatId);
    if (!backend?.isConnected()) throw new HarnessError("harness_transport_closed", "Reconnect before stopping native activity.");
    const binding = chat.state.session?.binding;
    if (!binding) throw new HarnessError("harness_session_not_owned", "Activity control requires an owned conversation.");
    return harnessActivityService.stopActivity({ kind: "chat", id: chatId }, binding, backend, activityId);
  }

  async ensureBackendConnected(
    chat: Chat,
    options: ReconnectChatOptions & { releaseOnly?: boolean } = {},
    workingDirectory?: ChatDirectoryResolution,
  ): Promise<Backend> {
    if (isExecutionHostChat(chat)) {
      if (!options.releaseOnly) await this.state.updateStartupStage(chat, "connecting_provider", {
        expectedStatus: chat.state.status,
      });
      return await this.ensureExecutionHostBackendConnected(chat, options);
    }
    const workspaceId = getChatWorkspaceId(chat);
    const workspace = await this.state.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${chat.config.workspaceId}`);
    }

    const working = workingDirectory ?? (options.releaseOnly
      ? { chat, directory: chat.state.session?.binding?.directory ?? chat.config.directory }
      : await this.worktree.resolveWorkingDirectory(chat, {
      prepareWorkspace: !this.worktree.hasEstablishedWorkspaceContext(chat),
      signal: options.signal,
    }));
    const stagedWorking = workingDirectory || options.releaseOnly
      ? working
      : {
          ...working,
          chat: await this.state.updateStartupStage(working.chat, "connecting_provider", {
            expectedStatus: working.chat.state.status,
          }),
        };
    await this.backendManager.getBackendAsync(workspaceId);
    const backend = this.getChatBackend(stagedWorking.chat.config.id, workspaceId);
    const controlTools = !options.releaseOnly && isClankyControlChat(stagedWorking.chat, backend.harness.capabilities.adapter);
    const backendConnected = backend.isConnected();
    const controlModeChanged = backendConnected
      && this.connectedControlStates.get(backend) !== controlTools;
    if (!backendConnected || backend.getDirectory() !== stagedWorking.directory || controlModeChanged) {
      await this.onNativeDisconnect?.(chat.config.id);
      await harnessActivityService.close({ kind: "chat", id: chat.config.id });
      await backend.disconnect();
      const control = controlTools ? await createExecutionControlConnection(
        await managedContextIdentityResolver.forChat(stagedWorking.chat.config.id, workspaceId),
      ) : undefined;
      await backend.connect({
        ...buildConnectionConfig(
          await this.backendManager.getWorkspaceSettings(workspaceId),
          stagedWorking.directory,
          await sshKeyAccessService.environment(requireExecutionOwnerUserId(), { kind: "workspace", id: workspaceId }),
        ),
        control,
        controlTools,
        continuity: await this.continuityConfig(chat, options.releaseOnly),
      }, options.signal);
      this.connectedControlStates.set(backend, controlTools);
    }

    return backend;
  }

  async ensureSession(
    chat: Chat,
    backend: Backend,
    options?: {
      workingDirectory?: ChatDirectoryResolution;
      signal?: AbortSignal;
    },
  ): Promise<Chat> {
    throwIfAborted(options?.signal);
    if (chat.state.session?.id) {
      let existing: Awaited<ReturnType<typeof resumeOwnedHarnessSession>>;
      try {
        const context = await this.sessionContext(chat, backend);
        existing = await raceWithAbort(
          resumeOwnedHarnessSession(backend, chat.state.session, context),
          options?.signal,
        );
        throwIfAborted(options?.signal);
      } catch (error) {
        if (error instanceof HarnessError && error.code === "harness_session_not_found") {
          await this.failLostSession(chat, error);
        }
        throw error;
      }
      if (!existing) {
        const error = new HarnessError("harness_session_not_found", "The saved harness session is unavailable.");
        await this.failLostSession(chat, error);
        throw error;
      }
      if (existing.binding) chat = await this.state.updateState(chat, {
        ...chat.state, session: { id: existing.id, binding: existing.binding },
      });
      if (existing.binding) await this.observe(chat.config.id, existing.binding, backend, existing.continuity === "live" ? "live" : true, options?.signal);
      return await this.state.getChat(chat.config.id) ?? chat;
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
    const context = await this.sessionContext(stagedWorking.chat, backend);
    const sessionPromise = createOwnedHarnessSession(backend, {
      title: `Clanky Chat: ${stagedWorking.chat.config.name}`,
      directory: stagedWorking.directory,
      model: stagedWorking.chat.config.model.modelID,
    }, context);
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

    const created = await this.state.updateState(stagedWorking.chat, {
      ...stagedWorking.chat.state,
      session: {
        id: session.id,
        binding: session.binding,
      },
      startedAt: stagedWorking.chat.state.startedAt ?? createTimestamp(),
      lastActivityAt: createTimestamp(),
      error: undefined,
    }, {
      expectedStatus: options.signal ? stagedWorking.chat.state.status : undefined,
    });
    if (session.binding) await this.observe(chat.config.id, session.binding, backend);
    return await this.state.getChat(chat.config.id) ?? created;
  }

  async reconnectSession(chat: Chat, options: ReconnectChatOptions = {}): Promise<Chat> {
    let reconnectingChat = chat;
    try {
      const backend = await this.ensureBackendConnected(chat, options);
      reconnectingChat = await this.state.mutateState(chat.config.id, (current) => ({
        ...current.state, status: "reconnecting", error: undefined, lastActivityAt: createTimestamp(),
        ...(backend.harness.capabilities.remoteContinuity === 1 ? { connectionStatus: "connecting" as const } : {}),
      }));
      if (!reconnectingChat.state.session?.id) {
        reconnectingChat = await this.ensureSession(reconnectingChat, backend, {
          signal: options.signal,
        });
        return this.finishReconnect(reconnectingChat);
      }

      const context = await this.sessionContext(reconnectingChat, backend);
      const existing = await resumeOwnedHarnessSession(
        backend,
        reconnectingChat.state.session,
        context,
      );
      if (!existing) {
        throw new HarnessError("harness_session_not_found", "The saved harness session is unavailable.");
      }
      if (existing.continuity === "cold" || hasRemoteChatContinuity(reconnectingChat)
        && backend.harness.capabilities.remoteContinuity !== 1) {
        reconnectingChat = await this.state.mutateState(chat.config.id, (current) => ({
          ...current.state, pendingPermissionRequests: [],
          harness: {
            ...current.state.harness,
            questions: closeOpenQuestions(current.state.harness?.questions, "expired"),
          },
        }));
      } else if (existing.continuity === "live" && existing.pendingInteractions) {
        const pending = existing.pendingInteractions;
        reconnectingChat = await this.state.mutateState(chat.config.id, (current) => ({
          ...current.state,
          pendingPermissionRequests: current.state.pendingPermissionRequests?.filter((request) => pending.permissions.includes(request.requestId)),
          harness: {
            ...current.state.harness,
            questions: current.state.harness?.questions?.map((request) =>
              request.responseMode !== "message" && request.conversation.nativeId === existing.id
                && isQuestionOpen(request) && !pending.questions.includes(request.requestId)
                ? { ...request, status: pending.resolvedQuestions[request.requestId] ?? "expired", resolvedAt: createTimestamp() }
                : request),
          },
        }));
      }
      if (existing.binding) reconnectingChat = await this.state.mutateState(chat.config.id, (current) => ({
        ...current.state, session: { id: existing.id, binding: existing.binding },
      }));
      if (existing.binding) await this.observe(chat.config.id, existing.binding, backend, existing.continuity === "live" ? "live" : true, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (reconnectingChat === chat && !hasRemoteChatContinuity(chat)) throw error;
      if (hasRemoteChatContinuity(reconnectingChat) && isDomainError(error)
        && ["harness_transport_closed", "mesh_execution_unreachable", "mesh_execution_endpoint_unavailable",
          "mesh_worker_connection_unavailable", "mesh_relay_unavailable", "mesh_execution_session_invalid"].includes(error.code)) {
        const disconnected = await this.state.mutateState(chat.config.id, (current) => ({
          ...current.state, status: "reconnecting", connectionStatus: "disconnected", startupStage: undefined,
        }));
        this.state.emitChatUpdated(disconnected);
        throw error;
      }
      await this.failChat(reconnectingChat, error);
      throw error;
    }

    return this.finishReconnect(reconnectingChat);
  }

  async createSessionFromHistory(
    chat: Chat,
    options: ReconnectChatOptions & { directory: string },
  ): Promise<Chat> {
    const recovery = chat.state.harness?.historyRecovery;
    const recoveryId = recovery?.id;
    if (
      chat.state.status !== "starting"
      || !recoveryId
      || recovery?.status !== "exporting"
    ) {
      throw new HarnessError(
        "harness_runtime_unavailable",
        "The chat is not in a valid history-recovery session startup.",
      );
    }

    const originalExecutionHost = chat.config.executionHostBinding;
    const originalSessionId = chat.state.session?.id;
    let hostUpdated = false;
    try {
      const source = chat.config.source;
      const currentHost = source?.kind === "execution_host"
        ? source.executionHost
        : (await this.state.getWorkspace(getChatWorkspaceId(chat)))?.executionHostBinding;
      if (!currentHost || !executionHostBindingsEqual(currentHost, recovery.executionHost)) {
        throw new DomainError(
          "chat_history_recovery_conflict",
          "The chat's execution host changed while its recovery history was being exported. Continue from history again.",
        );
      }
      if (
        !originalExecutionHost
        || !executionHostBindingsEqual(originalExecutionHost, recovery.executionHost)
      ) {
        if (!await this.disconnectChat(chat.config.id)) {
          throw new HarnessError(
            "harness_transport_closed",
            "The previous chat backend could not be disconnected. The chat was not rebound.",
          );
        }
        throwIfAborted(options.signal);
        const updated = await this.state.updateConfig(chat.config.id, {
          ...chat.config,
          executionHostBinding: recovery.executionHost,
          updatedAt: createTimestamp(),
        });
        if (!updated) {
          throw new HarnessError("harness_session_not_found", "The chat is unavailable.");
        }
        hostUpdated = true;
        chat = updated;
      }
      const workingDirectory: ChatDirectoryResolution = {
        chat,
        directory: options.directory,
      };
      const backend = await this.ensureBackendConnected(
        chat,
        options,
        workingDirectory,
      );
      if (backend.getDirectory() !== options.directory) {
        throw new HarnessError(
          "harness_runtime_unavailable",
          "The selected execution host is not using the directory that contains the recovery history.",
        );
      }
      const created = await this.createSession(chat, backend, {
        prepareWorkspace: false,
        workingDirectory,
        signal: options.signal,
      });
      if (
        created.state.status !== "starting"
        || created.state.harness?.historyRecovery?.id !== recoveryId
        || created.state.harness.historyRecovery.status !== "exporting"
      ) {
        throw new HarnessError(
          "harness_runtime_unavailable",
          "The chat changed while the replacement provider session was being created.",
        );
      }
      return created;
    } catch (error) {
      if (hostUpdated) {
        const latest = await this.state.getChat(chat.config.id);
        if (latest && latest.state.session?.id === originalSessionId) {
          await this.state.updateConfig(chat.config.id, {
            ...latest.config,
            executionHostBinding: originalExecutionHost,
            updatedAt: createTimestamp(),
          });
        }
      }
      if (!options.signal?.aborted) {
        const latest = await this.state.getChat(chat.config.id);
        if (latest) {
          await this.failChat(latest, error);
        }
      }
      throw error;
    }
  }

  async disconnectChat(chatId: string, options: { preserveRemote?: boolean; signal?: AbortSignal } = {}): Promise<boolean> {
    const chat = await this.state.getChat(chatId);
    let backend = this.directChatBackends.get(chatId) ?? this.backendManager.getInitializedContextBackend(chatId);
    if (!options.preserveRemote && chat && hasRemoteChatContinuity(chat) && !backend?.isConnected()) {
      backend = await this.ensureBackendConnected(chat, { signal: options.signal, releaseOnly: true });
    }
    const preserve = options.preserveRemote && backend?.harness.capabilities.remoteContinuity === 1;
    const retained = backend?.harness.capabilities.remoteContinuity === 1;
    await this.onNativeDisconnect?.(chatId);
    await harnessActivityService.close({ kind: "chat", id: chatId }, !preserve && !retained);
    let releaseError: unknown;
    if (backend && retained && !preserve) {
      try {
        if (!backend.releaseRemoteExecution) throw new HarnessError("harness_unsupported_feature", "The retained remote runtime cannot be explicitly released.");
        await backend.releaseRemoteExecution(options.signal);
      } catch (error) {
        releaseError = error;
        log.warn("Remote execution release remains unconfirmed", { chatId, error: String(error) });
      }
    }
    if (!preserve && chat?.state.harness?.questions?.length) await this.state.updateState(chat, {
      ...chat.state, harness: { ...chat.state.harness, questions: closeOpenQuestions(chat.state.harness.questions, "expired") },
    });
    const directBackend = this.directChatBackends.get(chatId);
    let directDisconnectError: unknown;
    if (directBackend) {
      try {
        directBackend.abortAllSubscriptions();
        await directBackend.disconnect();
        this.directChatBackends.delete(chatId);
      } catch (error) {
        directDisconnectError = error;
        log.error("Failed to disconnect execution-host chat backend", { chatId, error: String(error) });
      }
    }
    const backendDisconnected = await this.backendManager.disconnectChat(chatId);
    if (releaseError) throw releaseError;
    if (directDisconnectError) {
      throw directDisconnectError;
    }
    return backendDisconnected;
  }

  private async sessionContext(chat: Chat, backend: Backend): Promise<Omit<HarnessConversationBinding, "adapter" | "nativeId">> {
    const controlTools = isClankyControlChat(chat, backend.harness.capabilities.adapter);
    const connectedControl = this.connectedControlStates.get(backend);
    if (connectedControl !== undefined && connectedControl !== controlTools) {
      throw new HarnessError("harness_transport_closed", "The Clanky control mode changed while the chat was connected. Reconnect before continuing.");
    }
    if (controlTools && backend.harness.capabilities.clankyControlTools !== true) {
      throw new HarnessError("harness_unsupported_feature", "This execution host does not support Clanky control tools.");
    }
    const unattended = chat.config.scope === "automation"
      && (await managedContextIdentityResolver.forChatSnapshot(chat)).contextType === "automation_run";
    return {
      ownerId: requireExecutionOwnerUserId(),
      contextId: chat.config.id,
      questionPolicy: unattended ? "unattended" as const : "interactive" as const,
      ...(!unattended && backend.harness.capabilities.secretFiles === 1 ? { secretFiles: 1 as const } : {}),
      directory: backend.getDirectory(),
      executionHost: chat.config.source?.kind === "execution_host" ? chat.config.source.executionHost : chat.config.executionHostBinding,
      ...(controlTools ? {
        controlTools: true,
        controlChatId: chat.config.id,
      } : {}),
    };
  }

  private async observe(chatId: string, binding: HarnessConversationBinding, backend: Backend, recover: boolean | "live" = false, signal?: AbortSignal): Promise<void> {
    if (this.onNativeSession) {
      const chat = await this.state.getChat(chatId);
      if (!chat) throw new HarnessError("harness_session_not_found", "The chat is unavailable.");
      await this.onNativeSession(chat, backend, binding, recover);
    }
    await harnessActivityService.observe({ kind: "chat", id: chatId }, binding, backend,
      this.onHarnessEvent ? (event) => this.onHarnessEvent!(chatId, binding, event) : undefined);
    await backend.startObservation?.(binding.nativeId, signal);
    if (backend.harness.capabilities.remoteContinuity === 1) {
      await this.state.mutateState(chatId, (current) => ({
        ...current.state, connectionStatus: "connected",
      }));
    }
  }

  async configureSessionModel(backend: Backend, sessionId: string, desiredModel: string): Promise<void> {
    await backend.setSessionModel(sessionId, desiredModel);
  }

  private async ensureExecutionHostBackendConnected(
    chat: Chat,
    options: ReconnectChatOptions & { releaseOnly?: boolean },
  ): Promise<Backend> {
    const source = chat.config.source;
    if (source?.kind !== "execution_host") {
      throw new Error(`Chat is not execution-host backed: ${chat.config.id}`);
    }
    const directory = source.directory || chat.config.directory;
    if (!source.adapter) throw new HarnessError("harness_model_not_available", "The selected execution-host adapter is unavailable.");
    const { provider } = createAgentSettings(source.adapter);
    const existing = await this.backendManager.getConnectedExecutionHostBackend({
      connectionId: chat.config.id,
      binding: source.executionHost,
      provider,
      directory,
    });
    if (existing) {
      this.directChatBackends.set(chat.config.id, existing);
      return existing;
    }
    const { backend, settings } = await this.backendManager.createBackendForExecutionHost(
      chat.config.id,
      source.executionHost,
      provider,
    );
    this.directChatBackends.set(chat.config.id, backend);
    await backend.connect({
      ...buildConnectionConfig(settings, directory,
        await sshKeyAccessService.environment(requireExecutionOwnerUserId(), { kind: "host", host: source.executionHost.host }),
      ),
      continuity: await this.continuityConfig(chat, options.releaseOnly),
    }, options.signal);
    return backend;
  }

  private async failLostSession(chat: Chat, error: unknown): Promise<Chat> {
    return this.failChat(chat, error);
  }

  private async failChat(chat: Chat, error: unknown): Promise<Chat> {
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = isDomainError(error) ? error.code : undefined;
    log.error("Chat runtime error", { chatId: chat.config.id, error: message });
    return this.state.markChatError(chat, message, errorCode);
  }

  private async continuityConfig(chat: Chat, releaseOnly = false) {
    if (!releaseOnly && chat.config.scope === "automation") {
      const run = await loadAutomationRunSummaryByChatId(chat.config.id);
      if (!run) throw new DomainError("automation_run_not_found", "The automation execution owner is unavailable.");
      if (isAutomationCodeEnabled(run.configSnapshot)) return undefined;
    }
    return { contextId: chat.config.id, binding: chat.state.session?.binding ?? undefined };
  }

  private async finishReconnect(chat: Chat): Promise<Chat> {
    return this.state.mutateState(chat.config.id, (current) => {
      if (current.state.status !== "reconnecting") return undefined;
      const waiting = current.state.harness?.questions?.some((request) => request.blocking && isQuestionOpen(request));
      const status = waiting ? "waiting" : this.hasActiveStream(chat.config.id) ? "streaming" : "idle";
      return {
        ...current.state,
        status,
        error: undefined,
        connectionStatus: isExecutionHostChat(current) || hasRemoteChatContinuity(current)
          ? "connected"
          : current.state.connectionStatus,
        startupStage: undefined,
        lastActivityAt: createTimestamp(),
      };
    });
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
