/**
 * Preserve relay pairings while admitting controller-direct collaboration.
 */
import type { Database } from "bun:sqlite";

export function migrateCollaborationDirectRoutes(db: Database): void {
  db.run("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      const invitations = db.query("PRAGMA table_info(collaboration_invitations)").all() as { name: string }[];
      if (!invitations.some((column) => column.name === "controller_url")) {
        db.run(`
          CREATE TABLE collaboration_invitations_routes (
            id TEXT PRIMARY KEY,
            owner_user_id TEXT NOT NULL REFERENCES webapp_users(id) ON DELETE CASCADE,
            token_hash TEXT NOT NULL UNIQUE,
            protocol_version INTEGER NOT NULL CHECK(protocol_version = 1),
            controller_node_id TEXT NOT NULL,
            controller_public_key TEXT NOT NULL,
            controller_fingerprint TEXT NOT NULL,
            name TEXT,
            controller_url TEXT,
            relay_url TEXT,
            relay_fingerprint TEXT,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed_at TEXT,
            revoked_at TEXT,
            workspace_count INTEGER NOT NULL CHECK(workspace_count >= 0),
            all_workspaces_admin INTEGER NOT NULL DEFAULT 0 CHECK(all_workspaces_admin IN (0, 1)),
            UNIQUE(id, owner_user_id),
            CHECK(
              (controller_url IS NOT NULL AND relay_url IS NULL AND relay_fingerprint IS NULL)
              OR (controller_url IS NULL AND relay_url IS NOT NULL AND relay_fingerprint IS NOT NULL)
            )
          );
          INSERT INTO collaboration_invitations_routes
            (id, owner_user_id, token_hash, protocol_version, controller_node_id, controller_public_key,
             controller_fingerprint, name, controller_url, relay_url, relay_fingerprint,
             created_at, expires_at, consumed_at, revoked_at, workspace_count, all_workspaces_admin)
          SELECT id, owner_user_id, token_hash, protocol_version, controller_node_id, controller_public_key,
            controller_fingerprint, name, NULL, relay_url, relay_fingerprint,
            created_at, expires_at, consumed_at, revoked_at, workspace_count, all_workspaces_admin
          FROM collaboration_invitations;
          DROP TABLE collaboration_invitations;
          ALTER TABLE collaboration_invitations_routes RENAME TO collaboration_invitations;
          CREATE INDEX idx_collaboration_invitations_owner
            ON collaboration_invitations(owner_user_id, expires_at);
        `);
      }
      const guests = db.query("PRAGMA table_info(collaboration_guests)").all() as { name: string }[];
      if (!guests.some((column) => column.name === "controller_url")) {
        db.run(`
          CREATE TABLE collaboration_guests_routes (
            id TEXT PRIMARY KEY,
            owner_user_id TEXT NOT NULL REFERENCES webapp_users(id) ON DELETE CASCADE,
            node_id TEXT NOT NULL UNIQUE,
            public_key TEXT NOT NULL,
            fingerprint TEXT NOT NULL UNIQUE,
            name TEXT,
            controller_url TEXT,
            relay_url TEXT,
            relay_fingerprint TEXT,
            created_at TEXT NOT NULL,
            revoked_at TEXT,
            all_workspaces_admin INTEGER NOT NULL DEFAULT 0 CHECK(all_workspaces_admin IN (0, 1)),
            UNIQUE(id, owner_user_id),
            CHECK(
              (controller_url IS NOT NULL AND relay_url IS NULL AND relay_fingerprint IS NULL)
              OR (controller_url IS NULL AND relay_url IS NOT NULL AND relay_fingerprint IS NOT NULL)
            )
          );
          INSERT INTO collaboration_guests_routes
            (id, owner_user_id, node_id, public_key, fingerprint, name,
             controller_url, relay_url, relay_fingerprint, created_at, revoked_at, all_workspaces_admin)
          SELECT id, owner_user_id, node_id, public_key, fingerprint, name,
            NULL, relay_url, relay_fingerprint, created_at, revoked_at, all_workspaces_admin
          FROM collaboration_guests;
          DROP TABLE collaboration_guests;
          ALTER TABLE collaboration_guests_routes RENAME TO collaboration_guests;
          CREATE INDEX idx_collaboration_guests_owner ON collaboration_guests(owner_user_id);
        `);
      }
      const connections = db.query("PRAGMA table_info(collaboration_connections)").all() as { name: string }[];
      if (!connections.some((column) => column.name === "controller_url")) {
        db.run(`
          CREATE TABLE collaboration_connections_routes (
            id TEXT PRIMARY KEY,
            local_user_id TEXT NOT NULL REFERENCES webapp_users(id) ON DELETE CASCADE,
            protocol_version INTEGER NOT NULL CHECK(protocol_version = 1),
            name TEXT,
            controller_node_id TEXT NOT NULL,
            controller_public_key TEXT NOT NULL,
            controller_fingerprint TEXT NOT NULL,
            controller_url TEXT,
            relay_url TEXT,
            relay_fingerprint TEXT,
            node_id TEXT NOT NULL UNIQUE,
            public_key TEXT NOT NULL,
            fingerprint TEXT NOT NULL UNIQUE,
            private_key_ciphertext TEXT,
            guest_id TEXT,
            status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'revoked')),
            created_at TEXT NOT NULL,
            pending_expires_at TEXT NOT NULL,
            CHECK(status = 'revoked' OR private_key_ciphertext IS NOT NULL),
            CHECK(status != 'active' OR guest_id IS NOT NULL),
            CHECK(
              (controller_url IS NOT NULL AND relay_url IS NULL AND relay_fingerprint IS NULL)
              OR (controller_url IS NULL AND relay_url IS NOT NULL AND relay_fingerprint IS NOT NULL)
            )
          );
          INSERT INTO collaboration_connections_routes
            (id, local_user_id, protocol_version, name, controller_node_id, controller_public_key,
             controller_fingerprint, controller_url, relay_url, relay_fingerprint,
             node_id, public_key, fingerprint, private_key_ciphertext, guest_id, status,
             created_at, pending_expires_at)
          SELECT id, local_user_id, protocol_version, name, controller_node_id, controller_public_key,
            controller_fingerprint, NULL, relay_url, relay_fingerprint,
            node_id, public_key, fingerprint, private_key_ciphertext, guest_id, status,
            created_at, pending_expires_at
          FROM collaboration_connections;
          DROP TABLE collaboration_connections;
          ALTER TABLE collaboration_connections_routes RENAME TO collaboration_connections;
          CREATE INDEX idx_collaboration_connections_owner ON collaboration_connections(local_user_id, status);
        `);
      }
      if (db.query("PRAGMA foreign_key_check").all().length) {
        throw new Error("Collaboration direct route migration violated foreign key constraints.");
      }
    }).immediate();
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
}
