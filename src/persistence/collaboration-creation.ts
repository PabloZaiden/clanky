/**
 * Creation metadata is recorded in the resource's own persistence transaction.
 */

import { getCollaborationActor } from "../context/user-context";
import { DomainError } from "../domain/domain-error";
import { setCollaborationAuthorshipOnce } from "./collaboration-authorship";
import { claimCollaborationInteractiveResource } from "./collaboration-interactive";
import { getCollaborationGuestByNodeInternal } from "./collaboration-guests";
import { getCollaborationOwner } from "./collaboration-storage";
import type { CollaborationCreator } from "@/shared/collaboration";

export function recordWorkspaceResourceCreation(input: {
  kind: "chat" | "task" | "terminal" | "preview";
  id: string;
  ownerUserId: string;
  workspaceId: string | null | undefined;
}): CollaborationCreator | undefined {
  if (!input.workspaceId) return;
  const actor = getCollaborationActor();
  let membershipId: string | null = null;
  let creator: { kind: "user" | "guest"; id: string; name: string };
  if (actor?.kind === "guest") {
    const guest = getCollaborationGuestByNodeInternal(actor.nodeId);
    if (!guest || guest.id !== actor.guestId || guest.ownerUserId !== input.ownerUserId
      || guest.revokedAt !== null || !guest.workspaceIds.includes(input.workspaceId)) {
      throw new DomainError("collaboration_access_denied", "Workspace access is no longer available.");
    }
    membershipId = guest.id;
    creator = { kind: "guest", id: guest.id, name: guest.name ?? "Collaborator" };
  } else {
    const owner = getCollaborationOwner(input.ownerUserId);
    if (!owner) throw new DomainError("collaboration_user_unavailable", "The resource owner is unavailable.");
    creator = { kind: "user", id: owner.id, name: owner.username };
  }
  if (input.kind === "chat" || input.kind === "task") {
    return setCollaborationAuthorshipOnce({ resourceKind: input.kind, resourceId: input.id,
      ownerUserId: input.ownerUserId, workspaceId: input.workspaceId, creator }).creator;
  } else {
    claimCollaborationInteractiveResource({ kind: input.kind, id: input.id,
      ownerUserId: input.ownerUserId, workspaceId: input.workspaceId, membershipId });
  }
}
