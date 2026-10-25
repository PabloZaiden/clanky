/**
 * Granted realtime interests and structured publication reference mapping.
 */

import type { RealtimeInterest, RealtimePublication } from "@pablozaiden/webapp/contracts";
import {
  decodeCollaborationResourceReference, encodeCollaborationResourceReference,
} from "@/shared/collaboration-reference";
import {
  WORKSPACE_REALTIME_RESOURCE_KINDS, isWorkspaceRealtimeEvent, type ClankyRealtimeEvent,
} from "@/shared/realtime";
import { workspaceEventReferenceFields } from "@/shared/workspace-event";
import { qualifyWorkspaceResponse } from "./response";

const REFERENCE_TARGETS = new Set(["id", "scope", "workspaceId", "taskId", "chatId", "agentId", "agentRunId", "terminalSessionId", "previewId"]);

export function collaborationRemoteInterest(interest: RealtimeInterest, connectionId: string): RealtimeInterest | undefined {
  const result = { ...interest, kinds: interest.kinds.filter((kind) => kind !== "action") };
  if (!result.kinds.length) return undefined;
  if (result.resources) {
    result.resources = result.resources.filter((resource) => WORKSPACE_REALTIME_RESOURCE_KINDS[resource]);
    if (!result.resources.length) return undefined;
  }
  const decode = (value: string): string | undefined => {
    const ref = decodeCollaborationResourceReference(value);
    return ref?.connectionId === connectionId ? ref.resourceId : undefined;
  };
  for (const selector of ["ids", "scopes"] as const) {
    if (!result[selector]) continue;
    result[selector] = result[selector].flatMap((value) => {
      const id = decode(value);
      return id ? [id] : [];
    });
    if (!result[selector].length) return undefined;
  }
  if (result.targets) {
    result.targets = { ...result.targets };
    for (const [key, values] of Object.entries(result.targets)) {
      if (!REFERENCE_TARGETS.has(key)) continue;
      const ids = (Array.isArray(values) ? values : [values]).flatMap((value) => {
        const id = decode(value);
        return id ? [id] : [];
      });
      if (!ids.length) return undefined;
      result.targets[key] = ids;
    }
  }
  return result;
}

export function qualifyCollaborationPublication(
  connectionId: string,
  publication: RealtimePublication,
): RealtimePublication<ClankyRealtimeEvent> | undefined {
  if (!isWorkspaceRealtimeEvent(publication.event)) return undefined;
  const qualify = (resourceKind: string, resourceId: string): string => encodeCollaborationResourceReference({
    connectionId, resourceKind, resourceId,
  });
  const fields = workspaceEventReferenceFields(publication.target);
  const target = { ...publication.target };
  for (const [field, kind] of Object.entries(fields)) {
    if (target[field]) target[field] = qualify(kind, target[field]!);
  }
  delete target["membershipId"];
  const event = qualifyWorkspaceResponse(publication.event, {
    resource: fields["id"] ?? "workspace", qualify, qualifyUrl: (path) => path,
  });
  if (!isWorkspaceRealtimeEvent(event)) return undefined;
  if ("resource" in event) {
    if (event.id && fields["id"]) event.id = qualify(fields["id"], event.id);
    if (event.scope && fields["scope"]) event.scope = qualify(fields["scope"], event.scope);
  }
  return { ...publication, event, target };
}
