import { AsyncLocalStorage } from "node:async_hooks";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import type { CollaborationActor, WorkspaceAccessAuthority } from "@/shared/collaboration";
import { DomainError } from "../domain/domain-error";

const userContext = new AsyncLocalStorage<CurrentUser>();
const actorContext = new AsyncLocalStorage<CollaborationActor>();
const workspaceContext = new AsyncLocalStorage<WorkspaceAccessAuthority | undefined>();
const resourceOwnerContext = new AsyncLocalStorage<CurrentUser | undefined>();

export interface WorkspaceExecutionContext {
  readonly authority: WorkspaceAccessAuthority;
  readonly owner: CurrentUser;
}

export function runWithCurrentUser<T>(user: CurrentUser, callback: () => T): T {
  return userContext.run(user, callback);
}

/** Admit authenticated work without inheriting an execution's authority. */
export function runWithAuthenticatedUser<T>(user: CurrentUser, callback: () => T): T {
  return userContext.run(user, () => actorContext.run({ kind: "user", userId: user.id },
    () => workspaceContext.run(undefined, () => resourceOwnerContext.run(undefined, callback))));
}

export function getCurrentUser(): CurrentUser | undefined {
  return userContext.getStore();
}

export function requireCurrentUser(): CurrentUser {
  const user = getCurrentUser();
  if (!user) {
    throw new Error("Current user context is required");
  }
  return user;
}

export function getCurrentUserId(): string | undefined {
  return getCurrentUser()?.id;
}

export function requireCurrentUserId(): string {
  return requireCurrentUser().id;
}

export function runWithCollaborationActor<T>(actor: CollaborationActor, callback: () => T): T {
  return actorContext.run(Object.freeze({ ...actor }), callback);
}

export function getCollaborationActor(): CollaborationActor | undefined {
  return actorContext.getStore()
    ?? (getCurrentUserId() ? { kind: "user", userId: requireCurrentUserId() } : undefined);
}

export function requireCollaborationActor(): CollaborationActor {
  const actor = getCollaborationActor();
  if (!actor) {
    throw new DomainError("collaboration_actor_required", "An authenticated collaboration actor is required.");
  }
  return actor;
}

/**
 * Only install authority returned by the Core workspace authorization boundary.
 * This does not replace the authenticated actor with the storage owner.
 */
export function runWithWorkspaceAccessAuthority<T>(
  authority: WorkspaceAccessAuthority,
  callback: () => T,
  owner?: CurrentUser,
): T {
  const actor = requireCollaborationActor();
  if (actor.kind !== authority.actor.kind
    || (actor.kind === "user" && (
      authority.actor.kind !== "user"
      || actor.userId !== authority.actor.userId
      || actor.userId !== authority.ownerUserId
      || authority.guestId !== null
    ))
    || (actor.kind === "guest" && (
      authority.actor.kind !== "guest"
      || actor.guestId !== authority.actor.guestId
      || actor.nodeId !== authority.actor.nodeId
      || actor.guestId !== authority.guestId
    ))) {
    throw new DomainError("collaboration_authority_mismatch", "Workspace authority does not match the authenticated actor.");
  }
  if (owner && owner.id !== authority.ownerUserId) {
    throw new DomainError("collaboration_authority_mismatch", "The execution owner does not match workspace authority.");
  }
  return workspaceContext.run(Object.freeze({
    ...authority,
    actor: Object.freeze({ ...authority.actor }),
    capabilities: Object.freeze([...authority.capabilities]),
  }), () => owner ? resourceOwnerContext.run(Object.freeze({ ...owner }), callback) : callback());
}

export function getWorkspaceAccessAuthority(): WorkspaceAccessAuthority | undefined {
  return workspaceContext.getStore();
}

/**
 * Runtime resources must explicitly name their authorized workspace when they
 * need the data owner. Unscoped persistence continues to use the current user.
 */
export function requireResourceOwnerUserId(workspaceId: string): string {
  const authority = getWorkspaceAccessAuthority();
  if (authority) {
    if (authority.workspaceId !== workspaceId) {
      throw new DomainError("collaboration_workspace_mismatch", "The resource is outside the authorized workspace.");
    }
    return authority.ownerUserId;
  }
  if (requireCollaborationActor().kind === "guest") {
    throw new DomainError("collaboration_authority_required", "Workspace authority is required for guest resources.");
  }
  return requireCurrentUserId();
}

export function requireResourceOwnerUser(workspaceId: string): CurrentUser {
  const ownerId = requireResourceOwnerUserId(workspaceId);
  const owner = resourceOwnerContext.getStore();
  if (owner?.id === ownerId) return owner;
  if (getCollaborationActor()?.kind === "guest") {
    throw new DomainError("collaboration_owner_context_required", "The workspace execution owner context is required.");
  }

  const user = requireCurrentUser();
  if (user.id === ownerId) return user;
  throw new DomainError("collaboration_owner_context_required", "The workspace execution owner context is required.");
}

export function getExecutionOwnerUserId(): string | undefined {
  return getWorkspaceAccessAuthority()?.ownerUserId
    ?? (getCollaborationActor()?.kind === "guest" ? undefined : getCurrentUserId());
}

export function requireExecutionOwnerUserId(): string {
  const authority = getWorkspaceAccessAuthority();
  return authority ? requireResourceOwnerUserId(authority.workspaceId) : requireResourceOwnerUserId("");
}

export function requireExecutionOwnerUser(): CurrentUser {
  const authority = getWorkspaceAccessAuthority();
  return requireResourceOwnerUser(authority?.workspaceId ?? "");
}

/** Resume admitted controller work, never use this to dispatch a new request. */
export function runWithExecutionOwner<T>(owner: CurrentUser, callback: () => T): T {
  return userContext.run(owner, () => actorContext.run({ kind: "user", userId: owner.id },
    () => workspaceContext.run(undefined, () => resourceOwnerContext.run(owner, callback))));
}

/**
 * Capture only after admission. Background work retains controller ownership,
 * not a live guest membership, and must not use this context for new requests.
 */
export function captureWorkspaceExecutionContext(workspaceId: string): WorkspaceExecutionContext {
  const owner = Object.freeze({ ...requireResourceOwnerUser(workspaceId) });
  return Object.freeze({
    owner,
    authority: Object.freeze({
      actor: Object.freeze({ kind: "user" as const, userId: owner.id }),
      ownerUserId: owner.id,
      workspaceId,
      guestId: null,
      capabilities: Object.freeze(["work"] as const),
    }),
  });
}

export function runWithWorkspaceExecutionContext<T>(
  execution: WorkspaceExecutionContext,
  callback: () => T,
): T {
  if (execution.owner.id !== execution.authority.ownerUserId
    || execution.authority.actor.kind !== "user"
    || execution.authority.actor.userId !== execution.owner.id
    || execution.authority.guestId !== null) {
    throw new DomainError("collaboration_authority_mismatch", "The background workspace execution context is invalid.");
  }
  return runWithCurrentUser(execution.owner, () => runWithCollaborationActor(execution.authority.actor,
    () => runWithWorkspaceAccessAuthority(execution.authority, callback, execution.owner)));
}
