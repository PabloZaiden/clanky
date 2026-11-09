import type { Database } from "bun:sqlite";

const LEGACY_TABLES = [
  "agent_run_transcript_meta",
  "agent_run_transcript_entries",
  "agent_runs",
  "agents",
] as const;

export function dropLegacyAutomationTables(db: Database): void {
  for (const table of LEGACY_TABLES) {
    const exists = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!exists) continue;
    if (db.query(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
      throw new Error(`Cannot remove populated legacy automation table: ${table}`);
    }
    db.run(`DROP TABLE ${table}`);
  }
}

export function renameAutomations(db: Database): void {
  for (const [before, after] of [
    ["agents", "automations"],
    ["agent_runs", "automation_runs"],
    ["agent_run_transcript_entries", "automation_run_transcript_entries"],
    ["agent_run_transcript_meta", "automation_run_transcript_meta"],
  ] as const) {
    const current = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(after);
    if (!current) db.run(`ALTER TABLE ${before} RENAME TO ${after}`);
  }
  for (const [table, before, after] of [
    ["automation_runs", "agent_id", "automation_id"],
    ["automation_run_transcript_entries", "agent_run_id", "automation_run_id"],
    ["automation_run_transcript_meta", "agent_run_id", "automation_run_id"],
  ] as const) {
    const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === before)) {
      db.run(`ALTER TABLE ${table} RENAME COLUMN ${before} TO ${after}`);
    }
  }
  db.run("UPDATE automations SET mode = 'automation' WHERE mode = 'agent'");
  db.run("UPDATE chats SET scope = 'automation' WHERE scope = 'agent'");
  db.run("UPDATE clanky_context_api_keys SET context_type = 'automation_run' WHERE context_type = 'agent_run'");

  for (const [before, after, definition] of [
    ["idx_agents_workspace_created_at", "idx_automations_workspace_created_at",
      "automations(user_id, workspace_id, created_at DESC)"],
    ["idx_agents_enabled_next_run", "idx_automations_enabled_next_run",
      "automations(user_id, enabled, next_run_at)"],
    ["idx_agent_runs_agent_created_at", "idx_automation_runs_automation_created_at",
      "automation_runs(user_id, automation_id, created_at DESC)"],
    ["idx_agent_runs_status", "idx_automation_runs_status",
      "automation_runs(user_id, status)"],
    ["idx_agent_run_transcript_entries_page", "idx_automation_run_transcript_entries_page",
      "automation_run_transcript_entries(user_id, automation_run_id, timestamp DESC, sequence DESC, kind DESC, entry_id DESC)"],
    ["idx_agent_run_transcript_meta_user", "idx_automation_run_transcript_meta_user",
      "automation_run_transcript_meta(user_id, automation_run_id)"],
    ["idx_agent_run_transcript_entries_assistant_page", "idx_automation_run_transcript_entries_assistant_page",
      "automation_run_transcript_entries(user_id, automation_run_id, timestamp DESC, sequence DESC, entry_id DESC) WHERE kind = 'message' AND message_role = 'assistant'"],
    ["idx_agent_run_transcript_entries_file_attachments", "idx_automation_run_transcript_entries_file_attachments",
      "automation_run_transcript_entries(automation_run_id, user_id, timestamp, sequence, kind, entry_id) WHERE message_has_files = 1"],
  ] as const) {
    db.run(`DROP INDEX IF EXISTS ${before}`);
    db.run(`CREATE INDEX IF NOT EXISTS ${after} ON ${definition}`);
  }
  dropLegacyAutomationTables(db);
}
