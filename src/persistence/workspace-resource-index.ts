/**
 * Ownership index used before a delegated operation establishes workspace scope.
 */
import { getDatabase } from "./database";

interface WorkspaceResourceRow {
  workspaceId: string;
}

const RESOURCE_QUERIES: Readonly<Record<string, string>> = {
  workspace: "SELECT id AS workspaceId FROM workspaces WHERE id = ? AND user_id = ?",
  task: "SELECT workspace_id AS workspaceId FROM tasks WHERE id = ? AND user_id = ?",
  chat: "SELECT workspace_id AS workspaceId FROM chats WHERE id = ? AND user_id = ? AND source_kind = 'workspace'",
  subagent: `SELECT COALESCE(c.workspace_id, t.workspace_id) AS workspaceId
    FROM harness_subagents s
    LEFT JOIN chats c ON c.id = s.chat_id AND c.user_id = s.user_id AND c.deleted_at IS NULL
    LEFT JOIN tasks t ON t.id = s.task_id AND t.user_id = s.user_id
    WHERE s.id = ? AND s.user_id = ? AND (c.id IS NOT NULL OR t.id IS NOT NULL)`,
  agent: "SELECT workspace_id AS workspaceId FROM agents WHERE id = ? AND user_id = ?",
  "agent-run": `SELECT a.workspace_id AS workspaceId
    FROM agent_runs r JOIN agents a ON a.id = r.agent_id AND a.user_id = r.user_id
    WHERE r.id = ? AND r.user_id = ?`,
  terminal: "SELECT workspace_id AS workspaceId FROM terminal_sessions WHERE id = ? AND user_id = ? AND workspace_id IS NOT NULL",
  preview: "SELECT workspace_id AS workspaceId FROM preview_sessions WHERE id = ? AND user_id = ? AND target_kind = 'workspace'",
  "review-comment": `SELECT t.workspace_id AS workspaceId
    FROM review_comments c JOIN tasks t ON t.id = c.task_id AND t.user_id = c.user_id
    WHERE c.id = ? AND c.user_id = ?`,
};

export function findResourceWorkspace(input: {
  resource: string;
  id: string;
  ownerUserId: string;
}): string | undefined {
  const query = Object.hasOwn(RESOURCE_QUERIES, input.resource)
    ? RESOURCE_QUERIES[input.resource] : undefined;
  if (!query) return undefined;
  return getDatabase().query<WorkspaceResourceRow, [string, string]>(query)
    .get(input.id, input.ownerUserId)?.workspaceId;
}

export function workspaceUsesExecutionHost(input: {
  workspaceId: string;
  ownerUserId: string;
  executionHostId: string;
}): boolean {
  return getDatabase().query<{ id: string }, [string, string, string]>(
    "SELECT id FROM workspaces WHERE id = ? AND user_id = ? AND execution_host_id = ?",
  ).get(input.workspaceId, input.ownerUserId, input.executionHostId) !== null;
}
