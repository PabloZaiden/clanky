/**
 * Server-side realtime contracts shared by Clanky domain event adapters.
 *
 * Core services remain transport-neutral. This module defines the narrow
 * application boundary used to translate owner-aware domain notifications into
 * framework resource events or intentionally retained streaming events.
 */

import type {
  AgentEvent,
  ChatEvent,
  PreviewEvent,
  ProvisioningEvent,
  TerminalSessionEvent,
  TaskEvent,
  WorkerUpdateEvent,
} from "@/shared";
import { PROMPT_TEMPLATES_REALTIME_RESOURCE } from "@/shared/prompt-templates";
import type { MeshStateEvent, HarnessStateEvent } from "./core/event-emitter";
import { createToolCallSummary, serializeExecutionHostRef } from "@/shared";
import type { ControlUiActionEvent } from "@/shared/clanky-control";
import type { LiveVoiceActivityEvent } from "@/shared/live-voice";
import { sanitizeProvisioningEvent } from "./lib/sensitive-data";
import type {
  RealtimeBus,
  RealtimeAction,
  RealtimeTarget,
  ResourceRealtimeEvent,
} from "@pablozaiden/webapp/server";

export const CLANKY_REALTIME_RESOURCES = {
  workspaces: "workspaces",
  tasks: "tasks",
  chats: "chats",
  chatActivity: "chat-activity",
  trash: "trash",
  agents: "agents",
  agentRuns: "agent-runs",
  terminalSessions: "terminal-sessions",
  provisioningJobs: "provisioning-jobs",
  workerUpdateJobs: "worker-update-jobs",
  previews: "previews",
  mesh: "mesh",
  executionHosts: "execution-hosts",
  promptTemplates: PROMPT_TEMPLATES_REALTIME_RESOURCE,
} as const;

export type ClankyRealtimeResource = typeof CLANKY_REALTIME_RESOURCES[keyof typeof CLANKY_REALTIME_RESOURCES];

type RetainedTaskEvent = Extract<
  TaskEvent,
  {
    type:
      | "task.message"
      | "task.message.delta"
      | "task.tool_call"
      | "task.tool_call.extra"
      | "task.log"
      | "task.log.delta"
      | "task.iteration.start"
      | "task.iteration.end"
      | "task.git.commit";
  }
>;

type RetainedChatEvent = Extract<
  ChatEvent,
  {
    type:
      | "chat.message"
      | "chat.message.delta"
      | "chat.tool_call"
      | "chat.tool_call.extra"
      | "chat.log"
      | "chat.log.delta";
  }
>;

type RetainedAgentEvent = Extract<
  AgentEvent,
  {
    type:
      | "agent.run.message"
      | "agent.run.message.delta"
      | "agent.run.tool_call"
      | "agent.run.tool_call.extra"
      | "agent.run.log"
      | "agent.run.log.delta";
  }
>;

type RetainedProvisioningEvent = Extract<
  ProvisioningEvent,
  {
    type: "provisioning.step" | "provisioning.updated" | "provisioning.output";
  }
>;

export type ClankyDomainEvent =
  | TaskEvent
  | ChatEvent
  | AgentEvent
  | TerminalSessionEvent
  | ProvisioningEvent
  | WorkerUpdateEvent
  | PreviewEvent
  | HarnessStateEvent
  | MeshStateEvent
  | ControlUiActionEvent
  | LiveVoiceActivityEvent;

export type ClankyStreamEvent =
  | RetainedTaskEvent
  | RetainedChatEvent
  | ControlUiActionEvent
  | LiveVoiceActivityEvent
  | RetainedAgentEvent
  | RetainedProvisioningEvent;

export type ClankyRealtimeEvent = ResourceRealtimeEvent | ClankyStreamEvent;

type ResourceAction = Extract<RealtimeAction, "changed" | "deleted">;

export interface ResourcePublication<TPayload = unknown> {
  resource: ClankyRealtimeResource;
  action: ResourceAction;
  id?: string;
  scope?: string;
  payload?: TPayload;
}

export interface RealtimeOwner {
  userId: string;
}

export interface ClankyRealtimePublisher {
  publishResource<TPayload>(
    owner: RealtimeOwner,
    publication: ResourcePublication<TPayload>,
  ): void;
  publishStream(
    owner: RealtimeOwner,
    event: ClankyStreamEvent,
    target: Omit<RealtimeTarget, "userId">,
  ): void;
}

export function createClankyRealtimePublisher(
  realtime: RealtimeBus<ClankyRealtimeEvent>,
): ClankyRealtimePublisher {
  return {
    publishResource<TPayload>(owner: RealtimeOwner, publication: ResourcePublication<TPayload>): void {
      const target: RealtimeTarget = {
        resource: publication.resource,
        userId: owner.userId,
        ...(publication.id ? { id: publication.id } : {}),
        ...(publication.scope ? { scope: publication.scope } : {}),
      };
      const options = {
        ...(publication.scope ? { scope: publication.scope } : {}),
        ...(publication.payload !== undefined ? { payload: publication.payload } : {}),
        target,
      };

      if (publication.action === "deleted") {
        if (!publication.id) {
          throw new Error(`Deleted realtime publication requires an id for ${publication.resource}`);
        }
        realtime.publishDeleted(publication.resource, publication.id, options);
        return;
      }
      if (publication.id) {
        realtime.publishEntityChanged(publication.resource, publication.id, options);
        return;
      }
      realtime.publishChanged(publication.resource, options);
    },
    publishStream(owner, event, target): void {
      realtime.publish(event, {
        kind: event.type === "control.ui_action" ? "action" : "content",
        target: {
          ...target,
          userId: owner.userId,
        },
      });
    },
  };
}

function publishChanged(
  publisher: ClankyRealtimePublisher,
  owner: RealtimeOwner,
  resource: ClankyRealtimeResource,
  id?: string,
  scope?: string,
): void {
  publisher.publishResource(owner, {
    resource,
    action: "changed",
    ...(id ? { id } : {}),
    ...(scope ? { scope } : {}),
  });
}

function publishDeleted(
  publisher: ClankyRealtimePublisher,
  owner: RealtimeOwner,
  resource: ClankyRealtimeResource,
  id: string,
  scope?: string,
): void {
  publisher.publishResource(owner, {
    resource,
    action: "deleted",
    id,
    ...(scope ? { scope } : {}),
  });
}

function publishStream(
  publisher: ClankyRealtimePublisher,
  owner: RealtimeOwner,
  event: ClankyStreamEvent,
  target: Omit<RealtimeTarget, "userId">,
): void {
  publisher.publishStream(owner, event, target);
}

function publishChatActivity(
  publisher: ClankyRealtimePublisher,
  owner: RealtimeOwner,
  event: RetainedChatEvent,
): void {
  publisher.publishResource(owner, {
    resource: CLANKY_REALTIME_RESOURCES.chatActivity,
    action: "changed",
    id: event.chatId,
    payload: {
      timestamp: event.timestamp,
      source: event.type === "chat.message" && event.message.role === "user" ? "user" : "stream",
    },
  });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled realtime event: ${String((value as { type?: unknown }).type)}`);
}

export function publishClankyDomainEvent(
  publisher: ClankyRealtimePublisher,
  event: ClankyDomainEvent,
  owner: RealtimeOwner,
): void {
  switch (event.type) {
    case "harness.changed":
      publishChanged(publisher, owner, event.context.kind === "chat" ? CLANKY_REALTIME_RESOURCES.chats : CLANKY_REALTIME_RESOURCES.tasks, event.context.id);
      for (const run of event.runs ?? []) {
        publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.agentRuns, run.id, run.agentId);
      }
      return;
    case "mesh.changed":
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.mesh);
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.executionHosts);
      return;
    case "task.created":
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.tasks, event.taskId);
      return;
    case "task.starting":
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.tasks, event.taskId);
      return;
    case "task.deleted":
      publishDeleted(publisher, owner, CLANKY_REALTIME_RESOURCES.tasks, event.taskId);
      return;
    case "task.message":
      if (event.message.role === "user") {
        publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.tasks, event.taskId);
      }
      publishStream(publisher, owner, event, { taskId: event.taskId });
      return;
    case "task.message.delta":
    case "task.log":
    case "task.log.delta":
      publishStream(publisher, owner, event, { taskId: event.taskId });
      return;
    case "task.tool_call":
      publishStream(
        publisher,
        owner,
        {
          ...event,
          tool: createToolCallSummary(event.tool),
        },
        { taskId: event.taskId },
      );
      return;
    case "task.tool_call.extra":
      // Extras can contain image bytes; expanded rows fetch them from the detail route.
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.tasks, event.taskId);
      return;
    case "task.iteration.start":
    case "task.iteration.end":
    case "task.git.commit":
      publishStream(publisher, owner, event, { taskId: event.taskId });
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.tasks, event.taskId);
      return;
    case "task.started":
    case "task.stopped":
    case "task.session_aborted":
    case "task.completed":
    case "task.terminal_handoff":
    case "task.error":
    case "task.merged":
    case "task.accepted":
    case "task.discarded":
    case "task.pushed":
    case "task.sync.started":
    case "task.sync.clean":
    case "task.sync.conflicts":
    case "task.sync.failed":
    case "task.plan.ready":
    case "task.plan.feedback":
    case "task.plan.accepted":
    case "task.plan.discarded":
    case "task.pending.updated":
    case "task.automatic_pr_flow.updated":
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.tasks, event.taskId);
      return;

    case "chat.created":
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.chats, event.chatId);
      return;
    case "chat.deleted":
      publishDeleted(publisher, owner, CLANKY_REALTIME_RESOURCES.chats, event.chatId);
      return;
    case "chat.trash.changed":
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.trash);
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.chats, event.chatId);
      return;
    case "chat.message":
      if (event.message.role === "user") {
        publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.chats, event.chatId);
      }
      publishChatActivity(publisher, owner, event);
      publishStream(publisher, owner, event, { chatId: event.chatId });
      return;
    case "chat.message.delta":
    case "chat.log":
    case "chat.log.delta":
      publishChatActivity(publisher, owner, event);
      publishStream(publisher, owner, event, { chatId: event.chatId });
      return;
    case "chat.tool_call.extra":
      // Tool-call summaries are enough for the live transcript. The complete
      // extra, which can contain image bytes, is fetched from the detail route.
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.chats, event.chatId);
      return;
    case "chat.tool_call":
      publishChatActivity(publisher, owner, event);
      publishStream(
        publisher,
        owner,
        {
          ...event,
          tool: createToolCallSummary(event.tool),
        },
        { chatId: event.chatId },
      );
      return;
    case "chat.status":
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.chats, event.chatId);
      return;
    case "chat.updated":
    case "chat.interrupted":
    case "chat.error":
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.chats, event.chatId);
      return;
    case "control.ui_action":
      publishStream(publisher, owner, event, {
        ...(event.source.kind === "chat_turn"
          ? { chatId: event.source.chatId, workspaceId: event.source.workspaceId } : {}),
        clientId: event.clientId,
      });
      return;
    case "voice.activity":
      publishStream(publisher, owner, event, { clientId: event.clientId });
      return;

    case "agent.created":
    case "agent.updated":
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.agents, event.agentId);
      return;
    case "agent.deleted":
      publishDeleted(publisher, owner, CLANKY_REALTIME_RESOURCES.agents, event.agentId);
      return;
    case "agent.run.message":
    case "agent.run.message.delta":
    case "agent.run.log":
    case "agent.run.log.delta":
      publishStream(publisher, owner, event, {
        agentId: event.agentId,
        agentRunId: event.agentRunId,
      });
      return;
    case "agent.run.tool_call":
      publishStream(
        publisher,
        owner,
        {
          ...event,
          tool: createToolCallSummary(event.tool),
        },
        {
          agentId: event.agentId,
          agentRunId: event.agentRunId,
        },
      );
      return;
    case "agent.run.tool_call.extra":
      // Extras can contain image bytes; expanded rows fetch them from the detail route.
      publishChanged(
        publisher,
        owner,
        CLANKY_REALTIME_RESOURCES.agentRuns,
        event.agentRunId,
        event.agentId,
      );
      return;
    case "agent.run.scheduled":
    case "agent.run.started":
    case "agent.run.status":
    case "agent.run.skipped":
    case "agent.run.completed":
    case "agent.run.failed":
    case "agent.run.interrupted":
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.agentRuns, event.agentRunId, event.agentId);
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.agents, event.agentId);
      return;
    case "agent.run.deleted":
      publishDeleted(publisher, owner, CLANKY_REALTIME_RESOURCES.agentRuns, event.agentRunId, event.agentId);
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.agents, event.agentId);
      return;
    case "agent.runs.purged":
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.agentRuns, undefined, event.agentId);
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.agents, event.agentId);
      return;

    case "terminal_session.created":
    case "terminal_session.updated":
    case "terminal_session.status":
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.terminalSessions, event.terminalSessionId);
      return;
    case "terminal_session.deleted":
      publishDeleted(publisher, owner, CLANKY_REALTIME_RESOURCES.terminalSessions, event.terminalSessionId);
      return;

    case "provisioning.started":
    case "provisioning.completed":
    case "provisioning.failed":
    case "provisioning.cancelled":
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.provisioningJobs, event.provisioningJobId);
      return;
    case "provisioning.dismissed":
      publishDeleted(publisher, owner, CLANKY_REALTIME_RESOURCES.provisioningJobs, event.provisioningJobId);
      return;
    case "provisioning.step":
    case "provisioning.updated":
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.provisioningJobs, event.provisioningJobId);
      publishStream(publisher, owner, sanitizeProvisioningEvent(event), {
        provisioningJobId: event.provisioningJobId,
      });
      return;
    case "provisioning.output":
      publishStream(publisher, owner, event, {
        provisioningJobId: event.provisioningJobId,
      });
      return;

    case "worker-update.changed":
      publishChanged(
        publisher,
        owner,
        CLANKY_REALTIME_RESOURCES.workerUpdateJobs,
        event.workerUpdateJobId,
      );
      return;
    case "worker-update.deleted":
      publishDeleted(
        publisher,
        owner,
        CLANKY_REALTIME_RESOURCES.workerUpdateJobs,
        event.workerUpdateJobId,
      );
      return;

    case "preview.created":
    case "preview.connected":
      {
        const binding = event.executionHostBinding
          ?? event.preview.config.executionHostBinding;
        const scope = event.workspaceId
          ?? (binding ? serializeExecutionHostRef(binding.host) : undefined);
      publishChanged(
        publisher,
        owner,
        CLANKY_REALTIME_RESOURCES.previews,
        event.previewId,
        scope,
      );
      return;
      }
    case "preview.closed":
    case "preview.failed":
      {
        const binding = event.executionHostBinding
          ?? event.preview?.config.executionHostBinding;
        const scope = event.workspaceId
          ?? (binding ? serializeExecutionHostRef(binding.host) : undefined);
      publishDeleted(
        publisher,
        owner,
        CLANKY_REALTIME_RESOURCES.previews,
        event.previewId,
        scope,
      );
      return;
      }
    default:
      assertNever(event);
  }
}
