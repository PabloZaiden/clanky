/**
 * Participant-specific terminal and preview authority, not content authorship.
 */

import type { CollaborationInteractiveResource } from "@/shared/collaboration";
import {
  AuthorizeCollaborationInteractiveResourceSchema,
  ClaimCollaborationInteractiveResourceSchema,
  ListCollaborationInteractiveResourcesSchema,
  ListGuestCollaborationInteractiveResourcesSchema,
  type AuthorizeCollaborationInteractiveResource,
  type ClaimCollaborationInteractiveResource,
  type ListCollaborationInteractiveResources,
  type ListGuestCollaborationInteractiveResources,
} from "@/contracts/schemas/collaboration";
import { DomainError } from "../domain/domain-error";
import {
  claimCollaborationInteractiveResource,
  getCollaborationInteractiveResource,
  listCollaborationInteractiveResourcesForPrincipal,
} from "../persistence/collaboration-interactive";
import { parseCollaborationInput } from "./collaboration-identity";
import { requireWorkspaceAccess } from "./collaboration-authority";

export function claimInteractiveResource(
  input: ClaimCollaborationInteractiveResource,
): CollaborationInteractiveResource {
  const parsed = parseCollaborationInput(ClaimCollaborationInteractiveResourceSchema, input);
  const authority = requireWorkspaceAccess(parsed.workspaceId);
  if (parsed.membershipId !== authority.guestId) {
    throw new DomainError("collaboration_interactive_forbidden", "Interactive resources must belong to the authenticated participant.");
  }
  return claimCollaborationInteractiveResource({ ...parsed, ownerUserId: authority.ownerUserId });
}

export function authorizeInteractiveResource(
  input: AuthorizeCollaborationInteractiveResource,
): CollaborationInteractiveResource {
  const parsed = parseCollaborationInput(AuthorizeCollaborationInteractiveResourceSchema, input);
  const authority = requireWorkspaceAccess(parsed.workspaceId);
  const resource = getCollaborationInteractiveResource(parsed.kind, parsed.id);
  if (!resource || resource.ownerUserId !== authority.ownerUserId || resource.workspaceId !== authority.workspaceId
    || resource.membershipId !== authority.guestId) {
    throw new DomainError("collaboration_interactive_forbidden", "This interactive resource belongs to another participant.");
  }
  return resource;
}

export function listInteractiveResources(
  input: ListCollaborationInteractiveResources,
): CollaborationInteractiveResource[] {
  const parsed = parseCollaborationInput(ListCollaborationInteractiveResourcesSchema, input);
  const authority = requireWorkspaceAccess(parsed.workspaceId, "read");
  return listCollaborationInteractiveResourcesForPrincipal({
    ownerUserId: authority.ownerUserId, membershipId: authority.guestId,
    workspaceId: parsed.workspaceId, ...(parsed.kind ? { kind: parsed.kind } : {}),
  });
}

/** Cleanup remains available after revocation; this is never request authority. */
export function listGuestInteractiveResourcesInternal(
  input: ListGuestCollaborationInteractiveResources,
): CollaborationInteractiveResource[] {
  const parsed = parseCollaborationInput(ListGuestCollaborationInteractiveResourcesSchema, input);
  const resources = listCollaborationInteractiveResourcesForPrincipal({
    ownerUserId: parsed.ownerUserId, membershipId: parsed.guestId,
  });
  return parsed.workspaceIds
    ? resources.filter((resource) => parsed.workspaceIds!.includes(resource.workspaceId))
    : resources;
}

export function getInteractiveResourceInternal(
  input: { kind: "terminal" | "preview"; id: string; workspaceId: string },
): CollaborationInteractiveResource | undefined {
  const parsed = parseCollaborationInput(AuthorizeCollaborationInteractiveResourceSchema, input);
  const resource = getCollaborationInteractiveResource(parsed.kind, parsed.id);
  return resource?.workspaceId === parsed.workspaceId ? resource : undefined;
}
