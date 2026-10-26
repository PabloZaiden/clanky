/**
 * Owner-wide workspace administration, without changing existing grants.
 */
import type { Database } from "bun:sqlite";

export function migrateCollaborationAdministration(db: Database): void {
  const columns = db.query("PRAGMA table_info(collaboration_invitations)").all() as { name: string }[];
  db.run("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      if (!columns.some((column) => column.name === "all_workspaces_admin")) {
        db.run(`
          CREATE TABLE collaboration_invitations_admin (
            id TEXT PRIMARY KEY,
            owner_user_id TEXT NOT NULL REFERENCES webapp_users(id) ON DELETE CASCADE,
            token_hash TEXT NOT NULL UNIQUE,
            protocol_version INTEGER NOT NULL CHECK(protocol_version = 1),
            controller_node_id TEXT NOT NULL,
            controller_public_key TEXT NOT NULL,
            controller_fingerprint TEXT NOT NULL,
            name TEXT,
            relay_url TEXT NOT NULL,
            relay_fingerprint TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed_at TEXT,
            revoked_at TEXT,
            workspace_count INTEGER NOT NULL CHECK(workspace_count >= 0),
            all_workspaces_admin INTEGER NOT NULL DEFAULT 0 CHECK(all_workspaces_admin IN (0, 1)),
            UNIQUE(id, owner_user_id)
          );
          INSERT INTO collaboration_invitations_admin
            SELECT *, 0 FROM collaboration_invitations;
          DROP TABLE collaboration_invitations;
          ALTER TABLE collaboration_invitations_admin RENAME TO collaboration_invitations;
          CREATE INDEX idx_collaboration_invitations_owner
            ON collaboration_invitations(owner_user_id, expires_at);
        `);
      }
      const guests = db.query("PRAGMA table_info(collaboration_guests)").all() as { name: string }[];
      if (!guests.some((column) => column.name === "all_workspaces_admin")) {
        db.run("ALTER TABLE collaboration_guests ADD COLUMN all_workspaces_admin INTEGER NOT NULL DEFAULT 0 CHECK(all_workspaces_admin IN (0, 1))");
      }
      if (db.query("PRAGMA foreign_key_check").all().length) {
        throw new Error("Collaboration administration migration violated foreign key constraints.");
      }
    }).immediate();
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
}
