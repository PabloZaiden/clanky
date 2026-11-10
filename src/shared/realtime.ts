/**
 * Browser/server-safe realtime event contracts and retained stream policy.
 */

import type { ResourceRealtimeEvent } from "@pablozaiden/webapp/contracts";
import type { TaskEvent, ChatEvent, AutomationEvent } from "./events";
import type { ProvisioningEvent } from "./provisioning";
import type { ControlUiActionEvent } from "./clanky-control";
import type { LiveVoiceActivityEvent } from "./live-voice";
import type { CollaborationResourceKind } from "./collaboration-reference";
import { PROMPT_TEMPLATES_REALTIME_RESOURCE } from "./prompt-templates";
import type { SubagentEvent } from "./subagent";
import type { TranscriptMessage } from "./transcript-attachments";
import type { MessageData } from "./events";

export const CLANKY_REALTIME_RESOURCES = {
  workspaces: "workspaces",
  tasks: "tasks",
  chats: "chats",
  subagents: "subagents",
  chatActivity: "chat-activity",
  trash: "trash",
  automations: "automations",
  automationRuns: "automation-runs",
  terminalSessions: "terminal-sessions",
  provisioningJobs: "provisioning-jobs",
  workerUpdateJobs: "worker-update-jobs",
  workerUpdatePreferences: "worker-update-preferences",
  previews: "previews",
  mesh: "mesh",
  executionHosts: "execution-hosts",
  controlRequests: "control-requests",
  controlCredentials: "control-credentials",
  notificationSettings: "notification-settings",
  promptTemplates: PROMPT_TEMPLATES_REALTIME_RESOURCE,
  sidebarPins: "sidebar-pins",
} as const;

export type ClankyRealtimeResource = typeof CLANKY_REALTIME_RESOURCES[keyof typeof CLANKY_REALTIME_RESOURCES];

type BrowserTranscriptEvent<T> = T extends { message: MessageData }
  ? Omit<T, "message"> & { message: TranscriptMessage }
  : T;

type RetainedTaskEvent = BrowserTranscriptEvent<Extract<TaskEvent, {
  type:
    | "task.message" | "task.message.delta" | "task.tool_call"
    | "task.log" | "task.log.delta" | "task.iteration.start" | "task.iteration.end" | "task.git.commit";
}>>;

export type RetainedChatEvent = BrowserTranscriptEvent<Extract<ChatEvent, {
  type:
    | "chat.message" | "chat.message.delta" | "chat.tool_call"
    | "chat.log" | "chat.log.delta";
}>>;

type RetainedAutomationEvent = BrowserTranscriptEvent<Extract<AutomationEvent, {
  type:
    | "automation.run.message" | "automation.run.message.delta" | "automation.run.tool_call"
    | "automation.run.log" | "automation.run.log.delta";
}>>;

type RetainedProvisioningEvent = Extract<ProvisioningEvent, {
  type: "provisioning.step" | "provisioning.updated" | "provisioning.output";
}>;

export type TranscriptContentEvent =
  | RetainedTaskEvent | RetainedChatEvent | RetainedAutomationEvent
  | Extract<SubagentEvent, { type: "subagent.transcript" }>;

export type ClankyStreamEvent =
  | TranscriptContentEvent | RetainedProvisioningEvent
  | ControlUiActionEvent | LiveVoiceActivityEvent;

export type ClankyRealtimeEvent = ResourceRealtimeEvent | ClankyStreamEvent;

export const WORKSPACE_REALTIME_RESOURCE_KINDS: Readonly<Record<string, CollaborationResourceKind>> = {
  workspaces: "workspace",
  tasks: "task",
  chats: "chat",
  subagents: "subagent",
  trash: "chat",
  "chat-activity": "chat",
  automations: "automation",
  "automation-runs": "automation-run",
  "terminal-sessions": "terminal",
  previews: "preview",
};

const WORKSPACE_STREAM_TYPES = new Set<string>([
  "subagent.transcript",
  "task.message", "task.message.delta", "task.tool_call",
  "task.log", "task.log.delta", "task.iteration.start", "task.iteration.end", "task.git.commit",
  "chat.message", "chat.message.delta", "chat.tool_call", "chat.log", "chat.log.delta",
  "automation.run.message", "automation.run.message.delta", "automation.run.tool_call",
  "automation.run.log", "automation.run.log.delta",
]);

export function isWorkspaceRealtimeEvent(value: unknown): value is ClankyRealtimeEvent {
  if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") return false;
  if ("resource" in value && typeof value.resource === "string"
    && WORKSPACE_REALTIME_RESOURCE_KINDS[value.resource]
    && "action" in value && (value.action === "changed" || value.action === "deleted")) {
    return value.type === `${value.resource}.${value.action}`;
  }
  return WORKSPACE_STREAM_TYPES.has(value.type);
}
