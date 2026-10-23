/**
 * Idempotent collaboration schema; remote content is never stored locally.
 */

import type { Database } from "bun:sqlite";

export function migrateCollaboration(db: Database): void {
  const terminalColumns = db.query("PRAGMA table_info(terminal_sessions)").all() as { name: string }[];
  if (!terminalColumns.some((column) => column.name === "collaboration_principal_id")) {
    db.run("ALTER TABLE terminal_sessions ADD COLUMN collaboration_principal_id TEXT NOT NULL DEFAULT 'owner'");
  }
  db.run(`
    DROP INDEX IF EXISTS idx_terminal_sessions_task_id_unique;
    CREATE UNIQUE INDEX idx_terminal_sessions_task_id_unique
      ON terminal_sessions(user_id, task_id, collaboration_principal_id) WHERE task_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_workspace_owner ON workspaces(id, user_id);
    CREATE TABLE IF NOT EXISTS collaboration_invitations (
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
      workspace_count INTEGER NOT NULL CHECK(workspace_count > 0),
      UNIQUE(id, owner_user_id)
    );
    CREATE TABLE IF NOT EXISTS collaboration_invitation_workspaces (
      invitation_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      PRIMARY KEY(invitation_id, workspace_id),
      FOREIGN KEY(invitation_id, owner_user_id)
        REFERENCES collaboration_invitations(id, owner_user_id) ON DELETE CASCADE,
      FOREIGN KEY(workspace_id, owner_user_id)
        REFERENCES workspaces(id, user_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS collaboration_guests (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES webapp_users(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      name TEXT,
      relay_url TEXT NOT NULL,
      relay_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      UNIQUE(id, owner_user_id)
    );
    CREATE TABLE IF NOT EXISTS collaboration_memberships (
      guest_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      revoked_at TEXT,
      PRIMARY KEY(guest_id, workspace_id),
      FOREIGN KEY(guest_id, owner_user_id)
        REFERENCES collaboration_guests(id, owner_user_id) ON DELETE CASCADE,
      FOREIGN KEY(workspace_id, owner_user_id)
        REFERENCES workspaces(id, user_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS collaboration_connections (
      id TEXT PRIMARY KEY,
      local_user_id TEXT NOT NULL REFERENCES webapp_users(id) ON DELETE CASCADE,
      protocol_version INTEGER NOT NULL CHECK(protocol_version = 1),
      name TEXT,
      controller_node_id TEXT NOT NULL,
      controller_public_key TEXT NOT NULL,
      controller_fingerprint TEXT NOT NULL,
      relay_url TEXT NOT NULL,
      relay_fingerprint TEXT NOT NULL,
      node_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      private_key_ciphertext TEXT,
      guest_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'revoked')),
      created_at TEXT NOT NULL,
      pending_expires_at TEXT NOT NULL,
      CHECK(status = 'revoked' OR private_key_ciphertext IS NOT NULL),
      CHECK(status != 'active' OR guest_id IS NOT NULL)
    );
    CREATE TABLE IF NOT EXISTS collaboration_authorship (
      resource_kind TEXT NOT NULL CHECK(resource_kind IN ('chat', 'task')),
      resource_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      creator_kind TEXT NOT NULL CHECK(creator_kind IN ('user', 'guest')),
      creator_id TEXT NOT NULL,
      creator_name TEXT NOT NULL,
      PRIMARY KEY(resource_kind, resource_id),
      FOREIGN KEY(workspace_id, owner_user_id)
        REFERENCES workspaces(id, user_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS collaboration_interactive_resources (
      resource_kind TEXT NOT NULL CHECK(resource_kind IN ('terminal', 'preview')),
      resource_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      membership_id TEXT,
      PRIMARY KEY(resource_kind, resource_id),
      FOREIGN KEY(workspace_id, owner_user_id)
        REFERENCES workspaces(id, user_id) ON DELETE CASCADE,
      FOREIGN KEY(membership_id, owner_user_id)
        REFERENCES collaboration_guests(id, owner_user_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_collaboration_invitations_owner
      ON collaboration_invitations(owner_user_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_collaboration_guests_owner
      ON collaboration_guests(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_collaboration_memberships_workspace
      ON collaboration_memberships(workspace_id, owner_user_id, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_collaboration_connections_owner
      ON collaboration_connections(local_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_collaboration_interactive_principal
      ON collaboration_interactive_resources(owner_user_id, membership_id, workspace_id);
    CREATE TRIGGER IF NOT EXISTS delete_chat_collaboration_authorship
      AFTER DELETE ON chats BEGIN
        DELETE FROM collaboration_authorship WHERE resource_kind = 'chat' AND resource_id = OLD.id;
      END;
    CREATE TRIGGER IF NOT EXISTS delete_task_collaboration_authorship
      AFTER DELETE ON tasks BEGIN
        DELETE FROM collaboration_authorship WHERE resource_kind = 'task' AND resource_id = OLD.id;
      END;
    CREATE TRIGGER IF NOT EXISTS delete_terminal_collaboration_principal
      AFTER DELETE ON terminal_sessions BEGIN
        DELETE FROM collaboration_interactive_resources
        WHERE resource_kind = 'terminal' AND resource_id = OLD.id;
      END;
    CREATE TRIGGER IF NOT EXISTS delete_preview_collaboration_principal
      AFTER DELETE ON preview_sessions BEGIN
        DELETE FROM collaboration_interactive_resources
        WHERE resource_kind = 'preview' AND resource_id = OLD.id;
      END;
    INSERT INTO collaboration_authorship
      (resource_kind, resource_id, owner_user_id, workspace_id, creator_kind, creator_id, creator_name)
    SELECT 'chat', chat.id, chat.user_id, chat.workspace_id, 'user', owner.id, owner.username
    FROM chats chat JOIN webapp_users owner ON owner.id = chat.user_id
    JOIN workspaces workspace ON workspace.id = chat.workspace_id AND workspace.user_id = chat.user_id
    WHERE 1
    ON CONFLICT(resource_kind, resource_id) DO NOTHING;
    INSERT INTO collaboration_authorship
      (resource_kind, resource_id, owner_user_id, workspace_id, creator_kind, creator_id, creator_name)
    SELECT 'task', task.id, task.user_id, task.workspace_id, 'user', owner.id, owner.username
    FROM tasks task JOIN webapp_users owner ON owner.id = task.user_id
    JOIN workspaces workspace ON workspace.id = task.workspace_id AND workspace.user_id = task.user_id
    WHERE 1
    ON CONFLICT(resource_kind, resource_id) DO NOTHING;
    INSERT INTO collaboration_interactive_resources
      (resource_kind, resource_id, owner_user_id, workspace_id, membership_id)
    SELECT 'terminal', terminal.id, terminal.user_id, terminal.workspace_id, NULL
    FROM terminal_sessions terminal JOIN workspaces workspace
      ON workspace.id = terminal.workspace_id AND workspace.user_id = terminal.user_id
    WHERE 1
    ON CONFLICT(resource_kind, resource_id) DO NOTHING;
    INSERT INTO collaboration_interactive_resources
      (resource_kind, resource_id, owner_user_id, workspace_id, membership_id)
    SELECT 'preview', preview.id, preview.user_id, preview.workspace_id, NULL
    FROM preview_sessions preview JOIN workspaces workspace
      ON workspace.id = preview.workspace_id AND workspace.user_id = preview.user_id
    WHERE 1
    ON CONFLICT(resource_kind, resource_id) DO NOTHING;
  `);
}
