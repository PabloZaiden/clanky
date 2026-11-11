/**
 * Server-side realtime contracts shared by Clanky domain event adapters.
 *
 * Core services remain transport-neutral. This module defines the narrow
 * application boundary used to translate owner-aware domain notifications into
 * framework resource events or intentionally retained streaming events.
 */

import type {
  AutomationEvent,
  ChatEvent,
  PreviewEvent,
  ProvisioningEvent,
  TerminalSessionEvent,
  TaskEvent,
  WorkerUpdateEvent,
} from "@/shared";
import {
  CLANKY_REALTIME_RESOURCES, type ClankyRealtimeResource, type ClankyStreamEvent,
  type ClankyRealtimeEvent, type RetainedChatEvent, type TranscriptResourceChange,
} from "@/shared/realtime";
import type { MeshStateEvent, HarnessStateEvent } from "./core/event-emitter";
import { createToolCallSummary, projectTranscriptMessage, serializeExecutionHostRef } from "@/shared";
import type { ControlUiActionEvent } from "@/shared/clanky-control";
import type { LiveVoiceActivityEvent } from "@/shared/live-voice";
import type { SubagentEvent } from "@/shared/subagent";
import { sanitizeProvisioningEvent } from "./lib/sensitive-data";
import { withLiveToolCallRevision } from "./core/transcript-service";
import type {
  RealtimeBus,
  RealtimeAction,
  RealtimeTarget,
} from "@pablozaiden/webapp/server";

export type ClankyDomainEvent =
  | TaskEvent
  | ChatEvent
  | AutomationEvent
  | TerminalSessionEvent
  | ProvisioningEvent
  | WorkerUpdateEvent
  | PreviewEvent
  | HarnessStateEvent
  | MeshStateEvent
  | ControlUiActionEvent
  | LiveVoiceActivityEvent
  | SubagentEvent;

type ResourceAction = Extract<RealtimeAction, "changed" | "deleted">;

export interface ResourcePublication<TPayload = unknown> {
  resource: ClankyRealtimeResource;
  action: ResourceAction;
  id?: string;
  scope?: string;
  workspaceId?: string;
  membershipId?: string | null;
  payload?: TPayload;
  chatId?: string;
  taskId?: string;
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
        ...(publication.workspaceId ? { workspaceId: publication.workspaceId } : {}),
        ...(publication.membershipId !== undefined ? { membershipId: publication.membershipId ?? "owner" } : {}),
        ...(publication.chatId ? { chatId: publication.chatId } : {}),
        ...(publication.taskId ? { taskId: publication.taskId } : {}),
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
  payload?: TranscriptResourceChange,
): void {
  publisher.publishResource(owner, {
    resource,
    action: "changed",
    ...(id ? { id } : {}),
    ...(scope ? { scope } : {}),
    ...(payload ? { payload } : {}),
  });
}

function publishDeleted(
  publisher: ClankyRealtimePublisher,
  owner: RealtimeOwner,
  resource: ClankyRealtimeResource,
  id: string,
  scope?: string,
  authority?: { workspaceId?: string; membershipId?: string | null },
): void {
  publisher.publishResource(owner, {
    resource,
    action: "deleted",
    id,
    ...(scope ? { scope } : {}),
    ...authority,
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
    case "subagent.changed":
      publisher.publishResource(owner, {
        resource: CLANKY_REALTIME_RESOURCES.subagents, action: "changed", id: event.subagentId,
        chatId: event.chatId, taskId: event.taskId,
      });
      return;
    case "subagent.transcript":
      publishStream(publisher, owner, {
        ...event,
        event: event.event.type === "transcript.message" ? {
          ...event.event,
          message: projectTranscriptMessage(
            event.event.message,
            `/api/${event.chatId ? "chats" : "tasks"}/${encodeURIComponent(event.chatId ?? event.taskId!)}/subagents/${encodeURIComponent(event.subagentId)}`,
          ),
        } : event.event,
      }, { subagentId: event.subagentId, chatId: event.chatId, taskId: event.taskId });
      return;
    case "harness.changed": {
      const payload: TranscriptResourceChange = { transcript: "unchanged" };
      publishChanged(publisher, owner, event.context.kind === "chat" ? CLANKY_REALTIME_RESOURCES.chats : CLANKY_REALTIME_RESOURCES.tasks, event.context.id, undefined, payload);
      for (const run of event.runs ?? []) {
        publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.automationRuns, run.id, run.automationId, payload);
      }
      return;
    }
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
      publishDeleted(publisher, owner, CLANKY_REALTIME_RESOURCES.tasks, event.taskId, undefined, { workspaceId: event.workspaceId });
      return;
    case "task.message":
      if (event.message.role === "user") {
        publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.tasks, event.taskId);
      }
      publishStream(publisher, owner, {
        ...event,
        message: projectTranscriptMessage(event.message, `/api/tasks/${encodeURIComponent(event.taskId)}`),
      }, { taskId: event.taskId });
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
          tool: createToolCallSummary(withLiveToolCallRevision(event.tool)),
        },
        { taskId: event.taskId },
      );
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
      publishDeleted(publisher, owner, CLANKY_REALTIME_RESOURCES.chats, event.chatId, undefined, { workspaceId: event.workspaceId });
      return;
    case "chat.trash.changed":
      for (const resource of [CLANKY_REALTIME_RESOURCES.trash, CLANKY_REALTIME_RESOURCES.chats]) {
        publisher.publishResource(owner, {
          resource, action: "changed", id: event.chatId, workspaceId: event.workspaceId,
        });
      }
      return;
    case "chat.message":
      if (event.message.role === "user") {
        publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.chats, event.chatId);
      }
      publishChatActivity(publisher, owner, event);
      publishStream(publisher, owner, {
        ...event,
        message: projectTranscriptMessage(event.message, `/api/chats/${encodeURIComponent(event.chatId)}`),
      }, { chatId: event.chatId });
      return;
    case "chat.message.delta":
    case "chat.log":
    case "chat.log.delta":
      publishChatActivity(publisher, owner, event);
      publishStream(publisher, owner, event, { chatId: event.chatId });
      return;
    case "chat.tool_call":
      publishChatActivity(publisher, owner, event);
      publishStream(
        publisher,
        owner,
        {
          ...event,
          tool: createToolCallSummary(withLiveToolCallRevision(event.tool)),
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

    case "automation.created":
    case "automation.updated":
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.automations, event.automationId);
      return;
    case "automation.deleted":
      publishDeleted(publisher, owner, CLANKY_REALTIME_RESOURCES.automations, event.automationId, undefined, { workspaceId: event.workspaceId });
      return;
    case "automation.run.message":
      publishStream(publisher, owner, {
        ...event,
        message: projectTranscriptMessage(event.message, `/api/automation-runs/${encodeURIComponent(event.automationRunId)}`),
      }, { automationId: event.automationId, automationRunId: event.automationRunId });
      return;
    case "automation.run.message.delta":
    case "automation.run.log":
    case "automation.run.log.delta":
      publishStream(publisher, owner, event, {
        automationId: event.automationId,
        automationRunId: event.automationRunId,
      });
      return;
    case "automation.run.tool_call":
      publishStream(
        publisher,
        owner,
        {
          ...event,
          tool: createToolCallSummary(withLiveToolCallRevision(event.tool)),
        },
        {
          automationId: event.automationId,
          automationRunId: event.automationRunId,
        },
      );
      return;
    case "automation.run.scheduled":
    case "automation.run.started":
    case "automation.run.status":
    case "automation.run.skipped":
    case "automation.run.completed":
    case "automation.run.failed":
    case "automation.run.interrupted":
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.automationRuns, event.automationRunId, event.automationId);
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.automations, event.automationId);
      return;
    case "automation.run.deleted":
      publishDeleted(publisher, owner, CLANKY_REALTIME_RESOURCES.automationRuns, event.automationRunId, event.automationId);
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.automations, event.automationId);
      return;
    case "automation.runs.purged":
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.automationRuns, undefined, event.automationId);
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.automations, event.automationId);
      return;

    case "terminal_session.created":
    case "terminal_session.updated":
    case "terminal_session.status":
      publishChanged(publisher, owner, CLANKY_REALTIME_RESOURCES.terminalSessions, event.terminalSessionId);
      return;
    case "terminal_session.deleted":
      publishDeleted(publisher, owner, CLANKY_REALTIME_RESOURCES.terminalSessions, event.terminalSessionId, undefined, {
        workspaceId: event.workspaceId, membershipId: event.membershipId,
      });
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
        { workspaceId: event.workspaceId, membershipId: event.membershipId },
      );
      return;
      }
    default:
      assertNever(event);
  }
}
