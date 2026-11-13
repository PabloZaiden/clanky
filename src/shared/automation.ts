/**
 * Automation type definitions for scheduled headless chat runs.
 *
 * Automations are workspace-scoped prompt schedules. Each run executes like a
 * non-interactive chat session with its own schedule and run history.
 */

import type { ChatPermissionRequest, ChatWorktreeState } from "./chat";
import type { MessageAttachment } from "./message-attachments";
import type { ModelConfig } from "./model";
import type { TokenUsageSummary } from "./harness-usage";
import type {
  PersistedMessage,
  PersistedToolCall,
  SessionInfo,
  ConversationLogEntry,
} from "./conversation";

export type AutomationScheduleIntervalUnit = "minutes" | "hours" | "days";

export interface AutomationScheduleInterval {
  value: number;
  unit: AutomationScheduleIntervalUnit;
}

export interface AutomationSchedule {
  /** Date/time string entered in the schedule timezone. */
  startAtLocal: string;
  /** IANA timezone used to interpret startAtLocal and day-based intervals. */
  timezone: string;
  /** Repeat interval after the initial startAtLocal. */
  interval: AutomationScheduleInterval;
  /** Next scheduled run as an absolute UTC ISO timestamp. */
  nextRunAt: string;
}

export interface AutomationConfigSnapshot {
  name: string;
  workspaceId: string;
  directory: string;
  prompt: string;
  code?: string;
  model: ModelConfig;
  baseBranch?: string;
  useWorktree: boolean;
  schedule: AutomationSchedule;
}

export interface AutomationConfig extends AutomationConfigSnapshot {
  id: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  generationChatId?: string;
  isPrivate?: boolean;
  mode: "automation";
}

export type AutomationStatus = "enabled" | "paused" | "running" | "error";

export interface AutomationError {
  message: string;
  timestamp: string;
  code?: string;
}

export interface AutomationState {
  id: string;
  status: AutomationStatus;
  lastRunAt?: string;
  nextRunAt?: string;
  lastSkippedAt?: string;
  lastError?: AutomationError;
  activeRunId?: string;
}

export interface Automation {
  config: AutomationConfig;
  state: AutomationState;
}

export type AutomationRunStatus =
  | "scheduled"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled"
  | "interrupted";

export type AutomationRunTrigger = "schedule" | "manual";

export interface AutomationRunError {
  message: string;
  timestamp: string;
  code?: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  chatId?: string;
  status: AutomationRunStatus;
  trigger: AutomationRunTrigger;
  scheduledFor: string;
  startedAt?: string;
  completedAt?: string;
  skipReason?: string;
  error?: AutomationRunError;
  session?: SessionInfo;
  usage?: TokenUsageSummary;
  worktree?: ChatWorktreeState;
  messages: PersistedMessage[];
  logs: ConversationLogEntry[];
  toolCalls: PersistedToolCall[];
  pendingPermissionRequests?: ChatPermissionRequest[];
  attachments?: MessageAttachment[];
  configSnapshot: AutomationConfigSnapshot;
  createdAt: string;
  updatedAt: string;
}

export function createInitialAutomationState(id: string, nextRunAt?: string): AutomationState {
  return {
    id,
    status: "enabled",
    nextRunAt,
  };
}

export function isAutomationRunActiveStatus(status: AutomationRunStatus): boolean {
  return status === "scheduled" || status === "starting" || status === "running";
}

export function isAutomationCodeEnabled(config: Pick<AutomationConfigSnapshot, "code">): boolean {
  return typeof config.code === "string" && config.code.trim().length > 0;
}
