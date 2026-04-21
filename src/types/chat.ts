/**
 * Chat type definitions for long-lived ACP-backed chat sessions.
 *
 * Chats are distinct from loops: they represent one resumable agent session
 * tied to a workspace and optional git worktree, with persisted transcript and
 * streaming artifacts used only for UI hydration and presentation.
 *
 * @module types/chat
 */

import type { ModelConfig } from "./schemas/model";
import type {
  LoopLogEntry,
  PersistedMessage,
  PersistedToolCall,
  SessionInfo,
} from "./loop";

export type { ModelConfig };

export interface ChatConfig {
  id: string;
  name: string;
  workspaceId: string;
  directory: string;
  model: ModelConfig;
  useWorktree: boolean;
  baseBranch?: string;
  createdAt: string;
  updatedAt: string;
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
  logs: LoopLogEntry[];
  toolCalls: PersistedToolCall[];
  activeMessageId?: string;
  interruptRequested?: boolean;
}

export interface Chat {
  config: ChatConfig;
  state: ChatState;
}

export const DEFAULT_CHAT_CONFIG = {
  useWorktree: true,
  mode: "chat" as const,
};

export function createInitialChatState(id: string): ChatState {
  return {
    id,
    status: "idle",
    messages: [],
    logs: [],
    toolCalls: [],
  };
}

export function isChatBusyStatus(status: ChatStatus): boolean {
  return status === "starting" || status === "streaming" || status === "interrupting";
}

export class ChatBusyError extends Error {
  readonly code = "chat_busy";
  readonly status = 409;

  constructor(message = "Chat is busy") {
    super(message);
    this.name = "ChatBusyError";
  }
}

export class EmptyChatTranscriptError extends Error {
  readonly code = "empty_transcript";
  readonly status = 400;

  constructor(message = "Chat transcript is empty. Send at least one message before spawning a loop.") {
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
