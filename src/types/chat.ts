/**
 * Chat type definitions for long-lived ACP-backed chat sessions.
 *
 * Chats are distinct from tasks: they represent one resumable agent session
 * tied to a workspace and optional git worktree, with persisted transcript and
 * streaming artifacts used only for UI hydration and presentation.
 *
 * @module types/chat
 */

import type { ModelConfig } from "./schemas/model";
import type {
  TaskLogEntry,
  PersistedMessage,
  PersistedToolCall,
  SessionInfo,
} from "./task";

export type { ModelConfig };

export type ChatScope = "workspace" | "task" | "agent";

export type ChatConnectionStatus =
  | "connected"
  | "disconnected"
  | "needs_credentials"
  | "connecting"
  | "provider_unavailable"
  | "ssh_connection_failed"
  | "resume_failed";

export type ChatSource =
  | {
      kind: "workspace";
      workspaceId: string;
    }
  | {
      kind: "ssh_server";
      sshServerId: string;
      sshServerSessionId: string;
      directory: string;
    };

export interface ChatConfig {
  id: string;
  name: string;
  workspaceId: string;
  source?: ChatSource;
  scope: ChatScope;
  taskId?: string;
  directory: string;
  model: ModelConfig;
  useWorktree: boolean;
  autoApprovePermissions?: boolean;
  skipBaseBranchSync?: boolean;
  baseBranch?: string;
  createdAt: string;
  updatedAt: string;
  isPrivate?: boolean;
  mode: "chat";
}

export interface ChatWorktreeState {
  originalBranch: string;
  workingBranch: string;
  worktreePath?: string;
}

export interface ChatError {
  message: string;
  timestamp: string;
  code?: string;
}

export type ChatPermissionRequestStatus = "pending" | "approved" | "denied" | "cancelled";

export type ChatPermissionDecision = "allow" | "deny";

export interface ChatPermissionRequest {
  requestId: string;
  sessionId: string;
  permission: string;
  patterns: string[];
  status: ChatPermissionRequestStatus;
  createdAt: string;
  resolvedAt?: string;
  decision?: ChatPermissionDecision;
  error?: string;
}

export type ChatStatus =
  | "idle"
  | "starting"
  | "streaming"
  | "interrupting"
  | "reconnecting"
  | "stopped"
  | "failed";

export interface ChatState {
  id: string;
  status: ChatStatus;
  startedAt?: string;
  completedAt?: string;
  lastActivityAt?: string;
  session?: SessionInfo;
  error?: ChatError;
  worktree?: ChatWorktreeState;
  messages: PersistedMessage[];
  logs: TaskLogEntry[];
  toolCalls: PersistedToolCall[];
  hasMessages?: boolean;
  hasTranscript?: boolean;
  pendingPermissionRequests?: ChatPermissionRequest[];
  activeMessageId?: string;
  interruptRequested?: boolean;
  connectionStatus?: ChatConnectionStatus;
}

export interface Chat {
  config: ChatConfig;
  state: ChatState;
}

export const DEFAULT_CHAT_INTERRUPT_REASON = "user requested stop";

export const DEFAULT_CHAT_CONFIG = {
  useWorktree: true,
  autoApprovePermissions: true,
  mode: "chat" as const,
  scope: "workspace" as const,
};

export function createInitialChatState(id: string): ChatState {
  return {
    id,
    status: "idle",
    messages: [],
    logs: [],
    toolCalls: [],
    pendingPermissionRequests: [],
  };
}

export function isChatBusyStatus(status: ChatStatus): boolean {
  return status === "starting" || status === "streaming" || status === "interrupting";
}

export function isTaskChat(chat: Pick<Chat, "config"> | Pick<ChatConfig, "scope">): boolean {
  return "config" in chat ? chat.config.scope === "task" : chat.scope === "task";
}

export function isAgentChat(chat: Pick<Chat, "config"> | Pick<ChatConfig, "scope">): boolean {
  return "config" in chat ? chat.config.scope === "agent" : chat.scope === "agent";
}

export function isStandaloneChat(chat: Pick<Chat, "config"> | Pick<ChatConfig, "scope">): boolean {
  return !isTaskChat(chat) && !isAgentChat(chat);
}

export function isWorkspaceChat(chat: Pick<Chat, "config"> | ChatConfig): boolean {
  const config = "config" in chat ? chat.config : chat;
  return (config.source?.kind ?? "workspace") === "workspace";
}

export function isSshServerChat(chat: Pick<Chat, "config"> | ChatConfig): boolean {
  const config = "config" in chat ? chat.config : chat;
  return config.source?.kind === "ssh_server";
}

export function getChatWorkspaceId(chat: Pick<Chat, "config"> | ChatConfig): string {
  const config = "config" in chat ? chat.config : chat;
  if (config.source?.kind === "ssh_server") {
    throw new Error(`Chat is not workspace-backed: ${config.id}`);
  }
  return config.source?.workspaceId ?? config.workspaceId;
}

export class ChatBusyError extends Error {
  readonly code = "chat_busy";
  readonly status = 409;

  constructor(message = "Chat is busy") {
    super(message);
    this.name = "ChatBusyError";
  }
}

export class ChatPermissionRequestNotFoundError extends Error {
  readonly code = "permission_request_not_found";
  readonly status = 404;

  constructor(requestId: string) {
    super(`Pending permission request not found: ${requestId}`);
    this.name = "ChatPermissionRequestNotFoundError";
  }
}

export class ChatPermissionReplyError extends Error {
  readonly code = "permission_reply_failed";
  readonly status = 409;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChatPermissionReplyError";
  }
}

export class SshCredentialsRequiredError extends Error {
  readonly code = "ssh_credentials_required";
  readonly status = 400;

  constructor(message = "SSH credentials are required to reconnect this chat", options?: ErrorOptions) {
    super(message, options);
    this.name = "SshCredentialsRequiredError";
  }
}

export class EmptyChatTranscriptError extends Error {
  readonly code = "empty_transcript";
  readonly status = 400;

  constructor(message = "Chat transcript is empty. Send at least one message before spawning a task.") {
    super(message);
    this.name = "EmptyChatTranscriptError";
  }
}

export class InvalidCurrentPlanError extends Error {
  readonly code = "invalid_current_plan";
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "InvalidCurrentPlanError";
  }
}

export class InvalidChatBaseBranchError extends Error {
  readonly code = "invalid_chat_base_branch";
  readonly status = 400;
  readonly branchName: string;

  constructor(branchName: string) {
    super(`Standalone chat base branch '${branchName}' is not a valid git branch name.`);
    this.name = "InvalidChatBaseBranchError";
    this.branchName = branchName;
  }
}

export class ChatBranchCheckoutError extends Error {
  readonly code = "chat_branch_checkout_failed";
  readonly status = 409;
  readonly branchName: string;

  constructor(branchName: string, message = `Unable to switch the standalone chat to branch '${branchName}'.`, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChatBranchCheckoutError";
    this.branchName = branchName;
  }
}
