/**
 * Agent type definitions for scheduled headless chat runs.
 *
 * Agents are workspace-scoped prompt schedules. Each run executes like a
 * non-interactive chat session and is intentionally separate from Tasks.
 */

import type { ChatPermissionRequest, ChatWorktreeState } from "./chat";
import type { MessageImageAttachment } from "./message-attachments";
import type { ModelConfig } from "./model";
import type {
  PersistedMessage,
  PersistedToolCall,
  SessionInfo,
  TaskLogEntry,
} from "./task";

export type AgentScheduleIntervalUnit = "minutes" | "hours" | "days";

export interface AgentScheduleInterval {
  value: number;
  unit: AgentScheduleIntervalUnit;
}

export interface AgentSchedule {
  /** Date/time string entered in the schedule timezone. */
  startAtLocal: string;
  /** IANA timezone used to interpret startAtLocal and day-based intervals. */
  timezone: string;
  /** Repeat interval after the initial startAtLocal. */
  interval: AgentScheduleInterval;
  /** Next scheduled run as an absolute UTC ISO timestamp. */
  nextRunAt: string;
}

export interface AgentConfigSnapshot {
  name: string;
  workspaceId: string;
  directory: string;
  prompt: string;
  model: ModelConfig;
  baseBranch?: string;
  useWorktree: boolean;
  schedule: AgentSchedule;
}

export interface AgentConfig extends AgentConfigSnapshot {
  id: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  mode: "agent";
}

export type AgentStatus = "enabled" | "paused" | "running" | "error";

export interface AgentError {
  message: string;
  timestamp: string;
  code?: string;
}

export interface AgentState {
  id: string;
  status: AgentStatus;
  lastRunAt?: string;
  nextRunAt?: string;
  lastSkippedAt?: string;
  lastError?: AgentError;
  activeRunId?: string;
}

export interface Agent {
  config: AgentConfig;
  state: AgentState;
}

export type AgentRunStatus =
  | "scheduled"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled"
  | "interrupted";

export type AgentRunTrigger = "schedule" | "manual";

export interface AgentRunError {
  message: string;
  timestamp: string;
  code?: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  chatId?: string;
  status: AgentRunStatus;
  trigger: AgentRunTrigger;
  scheduledFor: string;
  startedAt?: string;
  completedAt?: string;
  skipReason?: string;
  error?: AgentRunError;
  session?: SessionInfo;
  worktree?: ChatWorktreeState;
  messages: PersistedMessage[];
  logs: TaskLogEntry[];
  toolCalls: PersistedToolCall[];
  pendingPermissionRequests?: ChatPermissionRequest[];
  attachments?: MessageImageAttachment[];
  configSnapshot: AgentConfigSnapshot;
  createdAt: string;
  updatedAt: string;
}

export function createInitialAgentState(id: string, nextRunAt?: string): AgentState {
  return {
    id,
    status: "enabled",
    nextRunAt,
  };
}

export function isAgentRunActiveStatus(status: AgentRunStatus): boolean {
  return status === "scheduled" || status === "starting" || status === "running";
}
