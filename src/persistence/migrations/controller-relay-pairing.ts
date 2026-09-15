import type { Database } from "bun:sqlite";

export function migrateControllerRelayPairing(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS mesh_controller_relay_pairing (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      relay_url TEXT NOT NULL,
      relay_public_key TEXT NOT NULL,
      relay_fingerprint TEXT NOT NULL,
      controller_node_id TEXT NOT NULL,
      controller_fingerprint TEXT NOT NULL,
      paired_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}
