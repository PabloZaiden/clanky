/**
 * Browser/server-safe realtime event contracts and retained stream policy.
 */

import type { ResourceRealtimeEvent } from "@pablozaiden/webapp/contracts";
import type { TaskEvent, ChatEvent, AgentEvent } from "./events";
import type { ProvisioningEvent } from "./provisioning";
import type { ControlUiActionEvent } from "./clanky-control";
import type { LiveVoiceActivityEvent } from "./live-voice";
import type { CollaborationResourceKind } from "./collaboration-reference";
import { PROMPT_TEMPLATES_REALTIME_RESOURCE } from "./prompt-templates";
import type { SubagentEvent } from "./subagent";

export const CLANKY_REALTIME_RESOURCES = {
  workspaces: "workspaces",
  tasks: "tasks",
  chats: "chats",
  subagents: "subagents",
  chatActivity: "chat-activity",
  trash: "trash",
  agents: "agents",
  agentRuns: "agent-runs",
  terminalSessions: "terminal-sessions",
  provisioningJobs: "provisioning-jobs",
  workerUpdateJobs: "worker-update-jobs",
  workerUpdatePreferences: "worker-update-preferences",
  previews: "previews",
  mesh: "mesh",
  executionHosts: "execution-hosts",
  promptTemplates: PROMPT_TEMPLATES_REALTIME_RESOURCE,
} as const;

export type ClankyRealtimeResource = typeof CLANKY_REALTIME_RESOURCES[keyof typeof CLANKY_REALTIME_RESOURCES];

type RetainedTaskEvent = Extract<TaskEvent, {
  type:
    | "task.message" | "task.message.delta" | "task.tool_call" | "task.tool_call.extra"
    | "task.log" | "task.log.delta" | "task.iteration.start" | "task.iteration.end" | "task.git.commit";
}>;

export type RetainedChatEvent = Extract<ChatEvent, {
  type:
    | "chat.message" | "chat.message.delta" | "chat.tool_call" | "chat.tool_call.extra"
    | "chat.log" | "chat.log.delta";
}>;

type RetainedAgentEvent = Extract<AgentEvent, {
  type:
    | "agent.run.message" | "agent.run.message.delta" | "agent.run.tool_call" | "agent.run.tool_call.extra"
    | "agent.run.log" | "agent.run.log.delta";
}>;

type RetainedProvisioningEvent = Extract<ProvisioningEvent, {
  type: "provisioning.step" | "provisioning.updated" | "provisioning.output";
}>;

export type ClankyStreamEvent =
  | RetainedTaskEvent | RetainedChatEvent | RetainedAgentEvent | RetainedProvisioningEvent
  | Extract<SubagentEvent, { type: "subagent.transcript" }>
  | ControlUiActionEvent | LiveVoiceActivityEvent;

export type ClankyRealtimeEvent = ResourceRealtimeEvent | ClankyStreamEvent;

export const WORKSPACE_REALTIME_RESOURCE_KINDS: Readonly<Record<string, CollaborationResourceKind>> = {
  workspaces: "workspace",
  tasks: "task",
  chats: "chat",
  subagents: "subagent",
  trash: "chat",
  "chat-activity": "chat",
  agents: "agent",
  "agent-runs": "agent-run",
  "terminal-sessions": "terminal",
  previews: "preview",
};

const WORKSPACE_STREAM_TYPES = new Set<string>([
  "subagent.transcript",
  "task.message", "task.message.delta", "task.tool_call", "task.tool_call.extra",
  "task.log", "task.log.delta", "task.iteration.start", "task.iteration.end", "task.git.commit",
  "chat.message", "chat.message.delta", "chat.tool_call", "chat.tool_call.extra", "chat.log", "chat.log.delta",
  "agent.run.message", "agent.run.message.delta", "agent.run.tool_call", "agent.run.tool_call.extra",
  "agent.run.log", "agent.run.log.delta",
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
