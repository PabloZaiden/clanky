/**
 * One-shot cleanup inventory retained until retired resources are confirmed gone.
 */
import { z } from "zod";
import { getDatabase } from "./database";

const SessionSchema = z.object({
  contextId: z.string(),
  directory: z.string(),
  nativeId: z.string(),
  bindingJson: z.string().nullable(),
  harnessStateJson: z.string().nullable(),
  settled: z.boolean().default(false),
  deleted: z.boolean().default(false),
});

export const RetiredTaskInventorySchema = z.object({
  version: z.literal(1),
  writersSettled: z.boolean(),
  sessions: z.array(SessionSchema),
  terminals: z.array(z.object({
    id: z.string(),
    directory: z.string(),
    connectionMode: z.string(),
    remoteSessionName: z.string(),
    executionHost: z.unknown(),
  })),
  attachments: z.array(z.object({
    contextKind: z.enum(["chat", "task"]),
    contextId: z.string(),
    directory: z.string(),
    executionHost: z.unknown(),
  })),
  worktrees: z.array(z.object({
    taskId: z.string(),
    repositoryDirectory: z.string(),
    path: z.string().nullable(),
    workingBranch: z.string().nullable(),
    originalBranch: z.string().nullable(),
    executionHost: z.unknown(),
  })),
});

export type RetiredTaskInventory = z.infer<typeof RetiredTaskInventorySchema>;

export function listRetiredTaskResources(): Array<{ userId: string; inventoryJson: string }> {
  return getDatabase().query<{ userId: string; inventoryJson: string }, []>(
    "SELECT user_id AS userId, inventory_json AS inventoryJson FROM retired_task_resources ORDER BY user_id",
  ).all();
}

export function saveRetiredTaskResources(userId: string, inventory: RetiredTaskInventory): void {
  getDatabase().query("UPDATE retired_task_resources SET inventory_json = ?, last_error = NULL WHERE user_id = ?")
    .run(JSON.stringify(RetiredTaskInventorySchema.parse(inventory)), userId);
}

export function recordRetiredTaskCleanupFailure(userId: string, error: string): void {
  getDatabase().query("UPDATE retired_task_resources SET last_error = ? WHERE user_id = ?").run(error, userId);
}

export function completeRetiredTaskCleanup(userId: string): void {
  getDatabase().query("DELETE FROM retired_task_resources WHERE user_id = ?").run(userId);
}

export function getRetirementProtectedDirectories(targetKey: string): string[] {
  const rows = getDatabase().query<{ directory: string }, [string]>(`
    WITH protected AS (
      SELECT directory, execution_host_id FROM workspaces
      UNION SELECT directory, execution_host_id FROM chats
      UNION SELECT worktree_path AS directory, execution_host_id FROM chats WHERE worktree_path IS NOT NULL
      UNION SELECT directory, execution_host_id FROM terminal_sessions
    )
    SELECT DISTINCT protected.directory FROM protected
      JOIN execution_hosts host ON host.id = protected.execution_host_id
    WHERE host.target_key = ?
  `).all(targetKey);
  return rows.map((row) => row.directory);
}
