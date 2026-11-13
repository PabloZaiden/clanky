import type { Database } from "bun:sqlite";
import { executionHostRefFromParts } from "@/shared/execution-host";
import type { RetiredTaskInventory } from "../retired-task-resources";

const RETIRED_TABLES = [
  "task_transcript_meta", "task_transcript_entries", "review_comments", "sessions", "tasks",
] as const;

interface LegacyHostRow {
  host_kind: string | null;
  host_source: string | null;
  host_target: string | null;
  host_revision: number | null;
}

function hostBinding(row: LegacyHostRow): unknown {
  const host = row.host_kind && row.host_source
    ? executionHostRefFromParts(row.host_kind, row.host_source) : null;
  return host && row.host_target && row.host_revision
    ? { host, targetKey: row.host_target, revision: row.host_revision } : null;
}

function rememberCleanupInventory(db: Database): void {
  db.run(`CREATE TABLE retired_task_resources (
    user_id TEXT PRIMARY KEY,
    inventory_json TEXT NOT NULL,
    last_error TEXT
  )`);
  const inventories = new Map<string, RetiredTaskInventory>();
  const inventoryFor = (userId: string): RetiredTaskInventory => {
    let inventory = inventories.get(userId);
    if (!inventory) {
      inventory = { version: 1, writersSettled: false, sessions: [], terminals: [], attachments: [], worktrees: [] };
      inventories.set(userId, inventory);
    }
    return inventory;
  };
  const addSessions = (inventory: RetiredTaskInventory, row: {
    id: string; directory: string; session_id: string | null; plan_session_id?: string | null;
    session_binding_json: string | null; harness_state_json: string | null;
  }): void => {
    const binding = row.session_binding_json ? JSON.parse(row.session_binding_json) as { nativeId?: unknown } : null;
    const ids = new Set([row.session_id, row.plan_session_id,
      typeof binding?.nativeId === "string" ? binding.nativeId : null]);
    for (const nativeId of ids) {
      if (nativeId) inventory.sessions.push({
        contextId: row.id, directory: row.directory, nativeId,
        bindingJson: row.session_binding_json, harnessStateJson: row.harness_state_json,
        settled: false, deleted: false,
      });
    }
  };
  const tasks = db.query(`SELECT task.id, task.user_id, task.directory,
      task.session_id, task.plan_session_id, task.session_binding_json, task.harness_state_json,
      task.git_worktree_path, task.git_working_branch, task.git_original_branch,
      workspace.directory AS repository_directory,
      host.kind AS host_kind, host.source_id AS host_source, host.target_key AS host_target,
      workspace.execution_host_revision AS host_revision
    FROM tasks task
    LEFT JOIN workspaces workspace ON workspace.id = task.workspace_id AND workspace.user_id = task.user_id
    LEFT JOIN execution_hosts host ON host.id = workspace.execution_host_id AND host.user_id = task.user_id
  `).all() as Array<LegacyHostRow & {
    id: string; user_id: string; directory: string; repository_directory: string | null;
    session_id: string | null; plan_session_id: string | null;
    session_binding_json: string | null; harness_state_json: string | null;
    git_worktree_path: string | null; git_working_branch: string | null; git_original_branch: string | null;
  }>;
  for (const task of tasks) {
    const inventory = inventoryFor(task.user_id);
    addSessions(inventory, task);
    if (task.git_worktree_path || task.git_working_branch) {
      const binding = task.session_binding_json
        ? JSON.parse(task.session_binding_json) as { executionHost?: unknown } : null;
      inventory.worktrees.push({
        taskId: task.id, repositoryDirectory: task.repository_directory ?? task.directory,
        path: task.git_worktree_path, workingBranch: task.git_working_branch,
        originalBranch: task.git_original_branch, executionHost: binding?.executionHost ?? hostBinding(task),
      });
    }
  }
  const chats = db.query(`SELECT id, user_id, directory, session_id, session_binding_json, harness_state_json
    FROM chats WHERE task_id IS NOT NULL OR scope = 'task'`).all() as Array<{
      id: string; user_id: string; directory: string; session_id: string | null;
      session_binding_json: string | null; harness_state_json: string | null;
    }>;
  for (const chat of chats) addSessions(inventoryFor(chat.user_id), chat);
  const terminals = db.query(`SELECT terminal.id, terminal.user_id, terminal.directory,
      COALESCE(terminal.runtime_connection_mode, terminal.connection_mode) AS connection_mode,
      terminal.remote_session_name,
      host.kind AS host_kind, host.source_id AS host_source, host.target_key AS host_target,
      terminal.execution_host_revision AS host_revision
    FROM terminal_sessions terminal
    LEFT JOIN execution_hosts host ON host.id = terminal.execution_host_id AND host.user_id = terminal.user_id
    WHERE terminal.task_id IS NOT NULL`).all() as Array<LegacyHostRow & {
      id: string; user_id: string; directory: string; connection_mode: string; remote_session_name: string;
    }>;
  for (const terminal of terminals) {
    inventoryFor(terminal.user_id).terminals.push({
      id: terminal.id, directory: terminal.directory, connectionMode: terminal.connection_mode,
      remoteSessionName: terminal.remote_session_name, executionHost: hostBinding(terminal),
    });
  }
  const attachments = db.query(`SELECT user_id, context_kind, context_id, directory, execution_host_json
    FROM conversation_attachment_locations location
    WHERE context_kind = 'task' OR (context_kind = 'chat' AND EXISTS (
      SELECT 1 FROM chats chat WHERE chat.id = location.context_id AND chat.user_id = location.user_id
        AND (chat.task_id IS NOT NULL OR chat.scope = 'task')
    ))`).all() as Array<{
      user_id: string; context_kind: "chat" | "task"; context_id: string;
      directory: string; execution_host_json: string;
    }>;
  for (const location of attachments) {
    inventoryFor(location.user_id).attachments.push({
      contextKind: location.context_kind, contextId: location.context_id, directory: location.directory,
      executionHost: JSON.parse(location.execution_host_json) as unknown,
    });
  }
  for (const [userId, inventory] of inventories) {
    if (inventory.sessions.length || inventory.terminals.length || inventory.attachments.length || inventory.worktrees.length) {
      db.query("INSERT INTO retired_task_resources (user_id, inventory_json) VALUES (?, ?)")
        .run(userId, JSON.stringify(inventory));
    }
  }
}

function deleteOwnedRecords(db: Database): void {
  const retiredChats = "SELECT id FROM chats WHERE task_id IS NOT NULL OR scope = 'task'";
  const retiredSubagents = `SELECT id FROM harness_subagents WHERE task_id IS NOT NULL OR chat_id IN (${retiredChats})`;
  db.run(`DELETE FROM subagent_transcript_entries WHERE subagent_id IN (${retiredSubagents})`);
  db.run(`DELETE FROM subagent_transcript_meta WHERE subagent_id IN (${retiredSubagents})`);
  db.run(`DELETE FROM harness_subagents WHERE task_id IS NOT NULL OR chat_id IN (${retiredChats})`);
  db.run(`DELETE FROM harness_usage WHERE task_id IS NOT NULL OR chat_id IN (${retiredChats})`);
  db.run(`DELETE FROM clanky_context_api_keys WHERE context_type = 'task'
    OR (context_type = 'chat' AND context_id IN (${retiredChats}))`);
  db.run(`DELETE FROM conversation_attachment_locations WHERE context_kind = 'task'
    OR (context_kind = 'chat' AND context_id IN (${retiredChats}))`);
  db.run(`DELETE FROM collaboration_authorship WHERE resource_kind = 'task'
    OR (resource_kind = 'chat' AND resource_id IN (${retiredChats}))`);
  db.run(`DELETE FROM collaboration_interactive_resources WHERE resource_kind = 'terminal'
    AND resource_id IN (SELECT id FROM terminal_sessions WHERE task_id IS NOT NULL)`);
  db.run("DELETE FROM terminal_sessions WHERE task_id IS NOT NULL");
  db.run(`DELETE FROM chat_transcript_entries WHERE chat_id IN (${retiredChats})`);
  db.run(`DELETE FROM chat_transcript_meta WHERE chat_id IN (${retiredChats})`);
  db.run(`DELETE FROM chats WHERE id IN (${retiredChats})`);
  db.run("DELETE FROM preferences WHERE key IN ('lastCheapModel', 'dashboardViewMode')");
  for (const table of RETIRED_TABLES) db.run(`DELETE FROM ${table}`);
}

function rebuildChatOwnership(db: Database): void {
  db.run("DROP TRIGGER IF EXISTS delete_standalone_chat_usage");
  db.run(`CREATE TABLE harness_usage_retiring (
    user_id TEXT NOT NULL REFERENCES webapp_users(id) ON DELETE CASCADE,
    source_key TEXT NOT NULL,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    snapshot_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('current', 'stale')),
    PRIMARY KEY (user_id, source_key)
  )`);
  db.run(`INSERT INTO harness_usage_retiring SELECT user_id, source_key, chat_id, snapshot_json, status FROM harness_usage`);
  db.run("DROP TABLE harness_usage");
  db.run("ALTER TABLE harness_usage_retiring RENAME TO harness_usage");
  db.run("CREATE INDEX idx_harness_usage_chat ON harness_usage(user_id, chat_id)");
  db.run(`CREATE TABLE harness_subagents_retiring (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES webapp_users(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    source_key TEXT NOT NULL,
    record_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(user_id, source_key)
  )`);
  db.run(`INSERT INTO harness_subagents_retiring SELECT id, user_id, chat_id, source_key, record_json, created_at FROM harness_subagents`);
  db.run("DROP TABLE harness_subagents");
  db.run("ALTER TABLE harness_subagents_retiring RENAME TO harness_subagents");
  db.run("CREATE INDEX idx_subagents_chat ON harness_subagents(user_id, chat_id, created_at DESC, id DESC)");
  db.run(`CREATE TABLE conversation_attachment_locations_retiring (
    user_id TEXT NOT NULL REFERENCES webapp_users(id) ON DELETE CASCADE,
    context_kind TEXT NOT NULL CHECK (context_kind = 'chat'),
    context_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    execution_host_json TEXT NOT NULL,
    directory TEXT NOT NULL,
    PRIMARY KEY (user_id, context_kind, context_id, location_id)
  )`);
  db.run(`INSERT INTO conversation_attachment_locations_retiring
    SELECT user_id, context_kind, context_id, location_id, execution_host_json, directory
    FROM conversation_attachment_locations`);
  db.run("DROP TABLE conversation_attachment_locations");
  db.run("ALTER TABLE conversation_attachment_locations_retiring RENAME TO conversation_attachment_locations");
  db.run("DROP TRIGGER IF EXISTS delete_chat_collaboration_authorship");
  db.run("DROP TRIGGER IF EXISTS delete_task_collaboration_authorship");
  db.run(`CREATE TABLE collaboration_authorship_retiring (
    resource_kind TEXT NOT NULL CHECK(resource_kind = 'chat'),
    resource_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    creator_kind TEXT NOT NULL CHECK(creator_kind IN ('user', 'guest')),
    creator_id TEXT NOT NULL,
    creator_name TEXT NOT NULL,
    PRIMARY KEY(resource_kind, resource_id),
    FOREIGN KEY(workspace_id, owner_user_id) REFERENCES workspaces(id, user_id) ON DELETE CASCADE
  )`);
  db.run("INSERT INTO collaboration_authorship_retiring SELECT * FROM collaboration_authorship");
  db.run("DROP TABLE collaboration_authorship");
  db.run("ALTER TABLE collaboration_authorship_retiring RENAME TO collaboration_authorship");
  db.run(`CREATE TRIGGER delete_chat_collaboration_authorship AFTER DELETE ON chats BEGIN
    DELETE FROM collaboration_authorship WHERE resource_kind = 'chat' AND resource_id = OLD.id;
  END`);
}

export function dropLegacyTaskTables(db: Database): void {
  for (const table of RETIRED_TABLES) {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
    if (db.query(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
      throw new Error(`Cannot remove populated retired Task table: ${table}`);
    }
    db.run(`DROP TABLE ${table}`);
  }
  // Dormant baseline columns remain only because its immutable indexes use them.
  for (const name of ["idx_chats_task_id_unique", "idx_terminal_sessions_task_id_unique"]) {
    db.run(`DROP INDEX IF EXISTS ${name}`);
  }
}

export function retireTasks(db: Database): void {
  const usageColumns = db.query("PRAGMA table_info(harness_usage)").all() as Array<{ name: string }>;
  if (!usageColumns.some((column) => column.name === "task_id")
    && db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'retired_task_resources'").get()) {
    dropLegacyTaskTables(db);
    return;
  }
  db.run("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      rememberCleanupInventory(db);
      deleteOwnedRecords(db);
      rebuildChatOwnership(db);
      dropLegacyTaskTables(db);
      const failures = db.query("PRAGMA foreign_key_check").all();
      if (failures.length) throw new Error("Task retirement would break foreign-key integrity.");
    }).immediate();
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
}

export function retireTaskPreferences(db: Database): void {
  db.run(`UPDATE preferences
    SET value = json_remove(value, '$.events.planReady', '$.events.blocked')
    WHERE key = 'notificationEvents'`);
  db.run("DELETE FROM preferences WHERE key IN ('lastCheapModel', 'dashboardViewMode')");
  db.run(`UPDATE preferences SET value = (
    SELECT json_group_array(json(pin.value)) FROM json_each(preferences.value) pin
    WHERE COALESCE(json_extract(pin.value, '$.route.view'), '') NOT IN ('task', 'tasks')
      AND json_extract(pin.value, '$.route.taskId') IS NULL
  ) WHERE key = 'sidebarPins'`);
}
