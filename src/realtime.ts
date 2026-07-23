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
  SshSessionEvent,
  TaskEvent,
} from "@/shared";
import { createToolCallSummary } from "@/shared";
import { isChatTerminalStatus } from "@/shared/chat";
import type {
  RealtimeBus,
  RealtimeAction,
  RealtimeTarget,
  ResourceRealtimeEvent,
} from "@pablozaiden/webapp/server";

export const CLANKY_REALTIME_RESOURCES = {
  tasks: "tasks",
  chats: "chats",
  agents: "agents",
  agentRuns: "agent-runs",
  sshSessions: "ssh-sessions",
  provisioningJobs: "provisioning-jobs",
  previews: "previews",
} as const;

export type ClankyRealtimeResource = typeof CLANKY_REALTIME_RESOURCES[keyof typeof CLANKY_REALTIME_RESOURCES];

type RetainedTaskEvent = Extract<
  TaskEvent,
  {
    type:
      | "task.message"
      | "task.progress"
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
      | "chat.status"
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
      | "agent.run.tool_call"
      | "agent.run.tool_call.extra"
      | "agent.run.log";
  }
>;

type RetainedProvisioningEvent = Extract<
  ProvisioningEvent,
  {
    type: "provisioning.step" | "provisioning.output";
  }
>;

export type ClankyDomainEvent =
  | TaskEvent
  | ChatEvent
  | AgentEvent
  | SshSessionEvent
  | ProvisioningEvent
  | PreviewEvent;

export type ClankyStreamEvent =
  | RetainedTaskEvent
  | RetainedChatEvent
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

function assertNever(value: never): never {
  throw new Error(`Unhandled realtime event: ${String((value as { type?: unknown }).type)}`);
}

export function publishClankyDomainEvent(
  publisher: ClankyRealtimePublisher,
  event: ClankyDomainEvent,
  owner: RealtimeOwner,
): void {
  switch (event.type) {
    case "task.created":
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.tasks, event.taskId);
      return;
    case "task.deleted":
      publishDeleted(publisher, owner, CLANKY_REALTIME_RESOURCES.tasks, event.taskId);
      return;
    case "task.message":
    case "task.progress":
    case "task.tool_call":
    case "task.tool_call.extra":
    case "task.log":
    case "task.log.delta":
      publishStream(publisher, owner, event, { taskId: event.taskId });
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
    case "task.ssh_handoff":
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
    case "chat.message":
    case "chat.message.delta":
    case "chat.log":
    case "chat.log.delta":
      publishStream(publisher, owner, event, { chatId: event.chatId });
      return;
    case "chat.tool_call.extra":
      // Tool-call summaries are enough for the live transcript. The complete
      // extra, which can contain image bytes, is fetched from the detail route.
      return;
    case "chat.tool_call":
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
      // Terminal status also closes the incremental client state when the
      // separate resource invalidation is missed.
      if (isChatTerminalStatus(event.status)) {
        publishStream(publisher, owner, event, { chatId: event.chatId });
      }
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.chats, event.chatId);
      return;
    case "chat.updated":
    case "chat.interrupted":
    case "chat.error":
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.chats, event.chatId);
      return;

    case "agent.created":
    case "agent.updated":
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.agents, event.agentId);
      return;
    case "agent.deleted":
      publishDeleted(publisher, owner, CLANKY_REALTIME_RESOURCES.agents, event.agentId);
      return;
    case "agent.run.message":
    case "agent.run.tool_call":
    case "agent.run.tool_call.extra":
    case "agent.run.log":
      publishStream(publisher, owner, event, {
        agentId: event.agentId,
        agentRunId: event.agentRunId,
      });
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

    case "ssh_session.created":
    case "ssh_session.updated":
    case "ssh_session.status":
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.sshSessions, event.sshSessionId);
      return;
    case "ssh_session.deleted":
      publishDeleted(publisher, owner, CLANKY_REALTIME_RESOURCES.sshSessions, event.sshSessionId);
      return;

    case "provisioning.started":
    case "provisioning.completed":
    case "provisioning.failed":
    case "provisioning.cancelled":
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.provisioningJobs, event.provisioningJobId);
      return;
    case "provisioning.step":
    case "provisioning.output":
      publishStream(publisher, owner, event, {
        provisioningJobId: event.provisioningJobId,
      });
      return;

    case "preview.created":
    case "preview.connected":
      publishChanged(
        publisher,
        owner,
        CLANKY_REALTIME_RESOURCES.previews,
        event.previewId,
        event.workspaceId,
      );
      return;
    case "preview.closed":
    case "preview.failed":
      publishDeleted(
        publisher,
        owner,
        CLANKY_REALTIME_RESOURCES.previews,
        event.previewId,
        event.workspaceId,
      );
      return;
    default:
      assertNever(event);
  }
}
