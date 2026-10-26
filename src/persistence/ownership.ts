import {
  getCollaborationActor,
  getWorkspaceAccessAuthority,
  getWorkspaceAdministrationAuthority,
  requireCurrentUserId,
  requireResourceOwnerUserId,
} from "../context/user-context";
import { DomainError } from "../domain/domain-error";
import { getDatabase } from "./database";

export type WorkspacePersistenceResource = "workspace" | "task" | "chat" | "agent" | "agent-run" | "terminal" | "preview" | "review-comment";

const RESOURCE_BINDINGS: Record<WorkspacePersistenceResource, string> = {
  workspace: "SELECT user_id AS owner, id AS workspace FROM workspaces WHERE id = ?",
  task: "SELECT user_id AS owner, workspace_id AS workspace FROM tasks WHERE id = ?",
  chat: "SELECT user_id AS owner, workspace_id AS workspace FROM chats WHERE id = ?",
  agent: "SELECT user_id AS owner, workspace_id AS workspace FROM agents WHERE id = ?",
  "agent-run": "SELECT run.user_id AS owner, agent.workspace_id AS workspace FROM agent_runs run JOIN agents agent ON agent.id = run.agent_id AND agent.user_id = run.user_id WHERE run.id = ?",
  terminal: "SELECT user_id AS owner, workspace_id AS workspace FROM terminal_sessions WHERE id = ?",
  preview: "SELECT user_id AS owner, workspace_id AS workspace FROM preview_sessions WHERE id = ?",
  "review-comment": "SELECT comment.user_id AS owner, task.workspace_id AS workspace FROM review_comments comment JOIN tasks task ON task.id = comment.task_id AND task.user_id = comment.user_id WHERE comment.id = ?",
};

export function requirePersistenceUserId(): string {
  return requireCurrentUserId();
}

export function requireWorkspacePersistenceUserId(workspaceId: string): string {
  return requireResourceOwnerUserId(workspaceId);
}

export function getPersistenceWorkspaceId(): string | undefined {
  return getWorkspaceAccessAuthority()?.workspaceId;
}

export function workspacePersistenceParameters(): [string | null, string | null] {
  const workspaceId = getPersistenceWorkspaceId() ?? null;
  return [workspaceId, workspaceId];
}

/**
 * Opt-in resource repositories only. Settings and global credentials continue
 * to use requirePersistenceUserId, which always identifies the actor.
 */
export function requireResourcePersistenceUserId(
  resource: WorkspacePersistenceResource,
  id?: string,
  workspaceId?: string | null,
): string {
  const scope = getWorkspaceAccessAuthority();
  if (!scope) {
    const administration = getWorkspaceAdministrationAuthority();
    if (administration && resource === "workspace") {
      const binding = id ? getDatabase().query(RESOURCE_BINDINGS.workspace).get(id) as { owner: string } | null : null;
      if (binding && binding.owner !== administration.ownerUserId) {
        throw new DomainError("collaboration_workspace_mismatch", "The workspace belongs to another owner.");
      }
      return administration.ownerUserId;
    }
    if (getCollaborationActor()?.kind === "guest") {
      throw new DomainError("collaboration_authority_required", "Workspace authority is required.");
    }
    return requireCurrentUserId();
  }
  if (workspaceId !== undefined && workspaceId !== scope.workspaceId) {
    throw new DomainError("collaboration_workspace_mismatch", "The resource is outside the authorized workspace.");
  }
  if (id) {
    const binding = getDatabase().query(RESOURCE_BINDINGS[resource]).get(id) as {
      owner: string; workspace: string | null;
    } | null;
    if (binding && (binding.owner !== scope.ownerUserId || binding.workspace !== scope.workspaceId)) {
      throw new DomainError("collaboration_workspace_mismatch", "The resource is outside the authorized workspace.");
    }
    if (binding && scope.guestId && (resource === "terminal" || resource === "preview")) {
      const principal = getDatabase().query(`
        SELECT membership_id FROM collaboration_interactive_resources WHERE resource_kind = ? AND resource_id = ?
      `).get(resource, id) as { membership_id: string | null } | null;
      if (principal?.membership_id !== scope.guestId) {
        throw new DomainError("collaboration_interactive_forbidden", "This interactive resource belongs to another participant.");
      }
    }
  }
  return scope.ownerUserId;
}

export function assertResourcePersistenceUser(
  resource: WorkspacePersistenceResource,
  id: string,
  userId: string,
): void {
  if (getWorkspaceAccessAuthority() && requireResourcePersistenceUserId(resource, id) !== userId) {
    throw new DomainError("collaboration_authority_mismatch", "The resource owner does not match workspace authority.");
  }
}

export function requireWorkspaceUpdateUserId(workspaceId: string, updates: object): string {
  const userId = requireResourcePersistenceUserId("workspace", workspaceId, workspaceId);
  if (getCollaborationActor()?.kind === "guest" && !getWorkspaceAccessAuthority()?.capabilities.includes("admin")
    && !getWorkspaceAdministrationAuthority()) {
    const keys = Reflect.ownKeys(updates);
    if (keys.length !== 1 || keys[0] !== "scratchpad"
      || typeof (updates as Record<string, unknown>)["scratchpad"] !== "string") {
      throw new DomainError("collaboration_admin_forbidden", "Collaborators can only update workspace scratchpad content.");
    }
  }
  return userId;
}

export function filterWorkspacePersistenceRows<T extends Record<string, unknown>>(
  rows: T[],
  interactiveKind?: "terminal" | "preview",
): T[] {
  const scope = getWorkspaceAccessAuthority();
  if (!scope) return rows;
  return rows.filter((row) => {
    if (row["workspace_id"] !== scope.workspaceId) return false;
    if (!interactiveKind || !scope.guestId) return true;
    const principal = getDatabase().query(`
      SELECT membership_id FROM collaboration_interactive_resources WHERE resource_kind = ? AND resource_id = ?
    `).get(interactiveKind, String(row["id"])) as { membership_id: string | null } | null;
    return principal?.membership_id === scope.guestId;
  });
}
