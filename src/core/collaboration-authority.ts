/**
 * Workspace-scoped authorization without changing the authenticated user.
 */

import type {
  CollaborationAuthorship,
  WorkspaceAccessAuthority,
  WorkspaceAccessCapability,
  CollaborationGuestAccess,
  CollaborationControllerAccess,
} from "@/shared/collaboration";
import {
  requireCollaborationActor,
  requireCurrentUserId,
  runWithWorkspaceAccessAuthority,
  runWithWorkspaceAdministration,
} from "../context/user-context";
import { DomainError } from "../domain/domain-error";
import {
  collaborationWorkspaceExists,
  getCollaborationOwner,
  getCollaborationOwnerUser,
} from "../persistence/collaboration-storage";
import { getCollaborationGuestByNodeInternal } from "../persistence/collaboration-guests";
import { getCollaborationAuthorship, setCollaborationAuthorshipOnce } from "../persistence/collaboration-authorship";
import {
  CollaborationAuthorshipResourceKindSchema,
  CollaborationIdSchema,
} from "@/contracts/schemas/collaboration";
import { parseCollaborationInput, validateCollaborationIdentity } from "./collaboration-identity";

export function requireCollaborationLocalUserId(): string {
  const actor = requireCollaborationActor();
  if (actor.kind !== "user") {
    throw new DomainError("collaboration_owner_required", "Only a local authenticated user can manage collaboration.");
  }
  const userId = requireCurrentUserId();
  if (actor.userId !== userId) {
    throw new DomainError("collaboration_owner_required", "Only a local authenticated user can manage collaboration.");
  }
  if (!getCollaborationOwner(userId)) {
    throw new DomainError("collaboration_user_unavailable", "The authenticated user is unavailable.");
  }
  return userId;
}

export function requireWorkspaceAccess(
  workspaceId: string,
  capability: WorkspaceAccessCapability = "work",
): WorkspaceAccessAuthority {
  parseCollaborationInput(CollaborationIdSchema, workspaceId);
  const actor = requireCollaborationActor();
  if (actor.kind === "user") {
    const ownerUserId = requireCollaborationLocalUserId();
    if (!collaborationWorkspaceExists(ownerUserId, workspaceId)) {
      throw new DomainError("collaboration_workspace_unavailable", "Workspace not found.");
    }
    return { actor, ownerUserId, workspaceId, guestId: null, capabilities: ["read", "work", "admin"] };
  }
  const guest = requireCollaborationGuest();
  if (!guest.workspaceIds.includes(workspaceId)) {
    throw new DomainError("collaboration_access_denied", "Workspace access is no longer available.");
  }
  validateCollaborationIdentity(guest.identity);
  if (capability === "admin" && !guest.allWorkspacesAdmin) {
    throw new DomainError("collaboration_admin_forbidden", "Collaborators cannot administer workspaces.");
  }
  const permission = guest.workspacePermissions[workspaceId];
  if (capability === "work" && permission !== "work") {
    throw new DomainError("collaboration_read_only", "This workspace is read-only.");
  }
  return { actor, ownerUserId: guest.ownerUserId, workspaceId, guestId: guest.id,
    capabilities: guest.allWorkspacesAdmin ? ["read", "work", "admin"] : permission === "work" ? ["read", "work"] : ["read"] };
}

function requireCollaborationGuest(): CollaborationGuestAccess {
  const actor = requireCollaborationActor();
  const guest = actor.kind === "guest" ? getCollaborationGuestByNodeInternal(actor.nodeId) : undefined;
  if (!guest || actor.kind !== "guest" || guest.id !== actor.guestId || guest.revokedAt !== null) {
    throw new DomainError("collaboration_access_denied", "The collaborator grant is unavailable.");
  }
  validateCollaborationIdentity(guest.identity);
  return guest;
}

export function getCollaborationControllerAccess(): CollaborationControllerAccess[] {
  if (requireCollaborationActor().kind === "user") return [];
  const guest = requireCollaborationGuest();
  return [{ id: guest.ownerUserId, name: guest.ownerUsername, allWorkspacesAdmin: guest.allWorkspacesAdmin }];
}

export function withWorkspaceAdministration<T>(controllerId: string | undefined, callback: () => T): T {
  const actor = requireCollaborationActor();
  const guest = requireCollaborationGuest();
  if (actor.kind !== "guest" || !guest.allWorkspacesAdmin
    || controllerId && controllerId !== guest.ownerUserId) {
    throw new DomainError("collaboration_admin_forbidden", "Administration of all workspaces is required.");
  }
  const owner = getCollaborationOwnerUser(guest.ownerUserId);
  if (!owner) throw new DomainError("collaboration_user_unavailable", "The workspace owner is unavailable.");
  return runWithWorkspaceAdministration({ actor, guestId: guest.id, ownerUserId: guest.ownerUserId }, owner, callback);
}

export function withWorkspaceAccess<T>(
  workspaceId: string,
  callback: (authority: WorkspaceAccessAuthority) => T,
  capability: WorkspaceAccessCapability = "work",
): T {
  const authority = requireWorkspaceAccess(workspaceId, capability);
  const owner = getCollaborationOwnerUser(authority.ownerUserId);
  if (!owner) {
    throw new DomainError("collaboration_user_unavailable", "The workspace owner is unavailable.");
  }
  return runWithWorkspaceAccessAuthority(authority, () => callback(authority), owner);
}

export function recordCollaborationCreator(
  kind: "chat" | "task",
  resourceId: string,
  workspaceId: string,
): CollaborationAuthorship {
  parseCollaborationInput(CollaborationAuthorshipResourceKindSchema, kind);
  const authority = requireWorkspaceAccess(workspaceId);
  parseCollaborationInput(CollaborationIdSchema, resourceId);
  let creator: CollaborationAuthorship["creator"];
  if (authority.actor.kind === "guest") {
    const guest = getCollaborationGuestByNodeInternal(authority.actor.nodeId);
    if (!guest || guest.id !== authority.guestId) {
      throw new DomainError("collaboration_access_denied", "Guest access is no longer available.");
    }
    creator = { kind: "guest", id: guest.id, name: guest.name ?? "Collaborator" };
  } else {
    const owner = getCollaborationOwner(authority.ownerUserId);
    if (!owner) {
      throw new DomainError("collaboration_user_unavailable", "The resource owner is unavailable.");
    }
    creator = { kind: "user", id: owner.id, name: owner.username };
  }
  return setCollaborationAuthorshipOnce({
    resourceKind: kind, resourceId, workspaceId, ownerUserId: authority.ownerUserId, creator,
  });
}

export function getCollaborationCreator(
  kind: "chat" | "task",
  resourceId: string,
  workspaceId: string,
): CollaborationAuthorship | undefined {
  parseCollaborationInput(CollaborationAuthorshipResourceKindSchema, kind);
  const authority = requireWorkspaceAccess(workspaceId, "read");
  parseCollaborationInput(CollaborationIdSchema, resourceId);
  return getCollaborationAuthorship(kind, resourceId, authority.ownerUserId, workspaceId);
}
