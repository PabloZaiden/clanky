/**
 * Resolves workspace and participant authority for private realtime publications.
 */
import type { RealtimePublication, RealtimeTarget } from "@pablozaiden/webapp/server";
import type { CollaborationGuestGrant } from "@/shared/collaboration";
import { WORKSPACE_REALTIME_RESOURCE_KINDS } from "../realtime";
import { findResourceWorkspace } from "../persistence/workspace-resource-index";
import { collaborationService } from "./collaboration-service";
import { isReadRecord } from "./resource-read-service";

export function findGuestResourceWorkspace(
  guest: CollaborationGuestGrant,
  resource: string,
  id: string,
): string | undefined {
  const workspaceId = findResourceWorkspace({ resource, id, ownerUserId: guest.ownerUserId });
  return workspaceId && guest.workspaceIds.includes(workspaceId) ? workspaceId : undefined;
}

export function resolveWorkspaceEventAuthority(
  guest: CollaborationGuestGrant,
  publication: RealtimePublication<unknown>,
): string | undefined {
  if (publication.target.userId !== guest.ownerUserId || !isReadRecord(publication.event)) return undefined;
  const { target, event } = publication;
  let resource = target.resource ? WORKSPACE_REALTIME_RESOURCE_KINDS[target.resource] : undefined;
  let id = target.id;
  if (publication.kind === "content") {
    const type = event["type"];
    if (typeof type !== "string") return undefined;
    if (type.startsWith("task.")) {
      resource = "task";
      id = target["taskId"];
    } else if (type.startsWith("chat.")) {
      resource = "chat";
      id = target["chatId"];
    } else if (type.startsWith("agent.run.")) {
      resource = "agent-run";
      id = target["agentRunId"];
    } else return undefined;
  } else if (publication.kind !== "state") return undefined;
  if (!resource || (publication.kind === "content" && !id)) return undefined;
  const workspaceId = target["workspaceId"]
    ?? (id ? findGuestResourceWorkspace(guest, resource, id) : undefined)
    ?? (resource === "agent-run" && target.scope
      ? findGuestResourceWorkspace(guest, "agent", target.scope) : undefined)
    ?? (resource === "preview" && target.scope && guest.workspaceIds.includes(target.scope)
      ? target.scope : undefined);
  if (!workspaceId || !guest.workspaceIds.includes(workspaceId)) return undefined;
  if (resource === "terminal" || resource === "preview") {
    if (!id) return undefined;
    const membershipId = target["membershipId"]
      ?? collaborationService.getInteractiveResourceInternal({
        kind: resource === "terminal" ? "terminal" : "preview", id, workspaceId,
      })?.membershipId;
    if (membershipId !== guest.id) return undefined;
  }
  return workspaceId;
}

export function workspaceEventReferenceFields(target: Readonly<RealtimeTarget>): Record<string, string> {
  const fields: Record<string, string> = {
    workspaceId: "workspace", taskId: "task", chatId: "chat",
    agentId: "agent", agentRunId: "agent-run", terminalSessionId: "terminal", previewId: "preview",
  };
  if (target.resource && WORKSPACE_REALTIME_RESOURCE_KINDS[target.resource]) {
    fields["id"] = WORKSPACE_REALTIME_RESOURCE_KINDS[target.resource]!;
    if (target.resource === "agent-runs") fields["scope"] = "agent";
    else if (target.resource === "previews") fields["scope"] = "workspace";
  }
  return fields;
}
