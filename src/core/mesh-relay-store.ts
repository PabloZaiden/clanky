/**
 * Relay-only SQLite persistence for controller pairing, worker authorization,
 * and payload-free audit metadata.
 */

import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  MeshRelayPeerIdentity,
  MeshRelayPeerRole,
  MeshRelayStreamKind,
} from "@/shared/mesh-relay";

export const RELAY_AUDIT_RETENTION_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const RELAY_AUDIT_RETENTION_ROWS = 20_000;
export const RELAY_STREAM_RETENTION_ROWS = 50_000;
const RELAY_PRUNE_INTERVAL_MS = 60_000;
const RELAY_PRUNE_WRITE_THRESHOLD = 1_000;

export interface RelayControllerPairing extends MeshRelayPeerIdentity {
  pairedAt: string;
  updatedAt: string;
}

export interface RelayAuditEvent {
  eventType: string;
  role?: MeshRelayPeerRole;
  nodeId?: string;
  connectionId?: string;
  outcome?: string;
  errorCode?: string;
  occurredAt?: string;
}

export interface RelayStreamAudit {
  streamId: string;
  initiatorNodeId: string;
  targetNodeId: string;
  kind: MeshRelayStreamKind;
  method?: string;
  path: string;
  status?: number;
  bytesToInitiator: number;
  bytesToReceiver: number;
  durationMs: number;
  outcome: string;
  errorCode?: string;
  occurredAt?: string;
}

interface ControllerRow {
  node_id: string;
  public_key: string;
  fingerprint: string;
  paired_at: string;
  updated_at: string;
}

interface WorkerRow {
  node_id: string;
  public_key: string;
  fingerprint: string;
}

export class MeshRelayStore {
  readonly databasePath: string;
  private readonly database: Database;
  private closed = false;
  private lastPrunedAt = 0;
  private writesSincePrune = 0;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    this.databasePath = join(dataDir, "relay.db");
    this.database = new Database(this.databasePath, { create: true, strict: true });
    chmodSync(this.databasePath, 0o600);
    this.initialize();
  }

  private initialize(): void {
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS relay_controller (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        node_id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        paired_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relay_workers (
        node_id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        authorized_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relay_audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        role TEXT,
        node_id TEXT,
        connection_id TEXT,
        outcome TEXT,
        error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_relay_audit_occurred
        ON relay_audit_events(occurred_at);
      CREATE TABLE IF NOT EXISTS relay_stream_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        initiator_node_id TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        method TEXT,
        path TEXT NOT NULL,
        status INTEGER,
        bytes_to_initiator INTEGER NOT NULL,
        bytes_to_receiver INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_relay_stream_occurred
        ON relay_stream_audit(occurred_at);
    `);
    this.prune();
  }

  getController(): RelayControllerPairing | undefined {
    const row = this.database.prepare(`
      SELECT node_id, public_key, fingerprint, paired_at, updated_at
      FROM relay_controller
      WHERE singleton = ?
    `).get(1) as ControllerRow | null;
    return row
      ? {
          nodeId: row.node_id,
          publicKey: row.public_key,
          fingerprint: row.fingerprint,
          pairedAt: row.paired_at,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  pairController(identity: MeshRelayPeerIdentity): RelayControllerPairing {
    const existing = this.getController();
    if (
      existing
      && (
        existing.nodeId !== identity.nodeId
        || existing.publicKey !== identity.publicKey
        || existing.fingerprint !== identity.fingerprint
      )
    ) {
      throw new Error("The relay is already paired with a different controller identity.");
    }
    const now = new Date().toISOString();
    const pairedAt = existing?.pairedAt ?? now;
    this.database.prepare(`
      INSERT INTO relay_controller (
        singleton, node_id, public_key, fingerprint, paired_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        node_id = excluded.node_id,
        public_key = excluded.public_key,
        fingerprint = excluded.fingerprint,
        updated_at = excluded.updated_at
    `).run(
      1,
      identity.nodeId,
      identity.publicKey,
      identity.fingerprint,
      pairedAt,
      now,
    );
    return { ...identity, pairedAt, updatedAt: now };
  }

  resetPairing(): void {
    const reset = this.database.transaction(() => {
      this.database.prepare("DELETE FROM relay_workers").run();
      this.database.prepare("DELETE FROM relay_controller").run();
    });
    reset.immediate();
    this.audit({
      eventType: "pairing.reset",
      outcome: "accepted",
    });
  }

  getAuthorizedWorker(nodeId: string): MeshRelayPeerIdentity | undefined {
    const row = this.database.prepare(`
      SELECT node_id, public_key, fingerprint
      FROM relay_workers
      WHERE node_id = ?
    `).get(nodeId) as WorkerRow | null;
    return row
      ? {
          nodeId: row.node_id,
          publicKey: row.public_key,
          fingerprint: row.fingerprint,
        }
      : undefined;
  }

  listAuthorizedWorkers(): MeshRelayPeerIdentity[] {
    const rows = this.database.prepare(`
      SELECT node_id, public_key, fingerprint
      FROM relay_workers
      ORDER BY node_id
    `).all() as WorkerRow[];
    return rows.map((row) => ({
      nodeId: row.node_id,
      publicKey: row.public_key,
      fingerprint: row.fingerprint,
    }));
  }

  replaceAuthorizedWorkers(workers: readonly MeshRelayPeerIdentity[]): void {
    const replace = this.database.transaction(
      (identities: readonly MeshRelayPeerIdentity[]) => {
        this.database.prepare("DELETE FROM relay_workers").run();
        const insert = this.database.prepare(`
          INSERT INTO relay_workers (
            node_id, public_key, fingerprint, authorized_at
          ) VALUES (?, ?, ?, ?)
        `);
        const now = new Date().toISOString();
        for (const identity of identities) {
          insert.run(
            identity.nodeId,
            identity.publicKey,
            identity.fingerprint,
            now,
          );
        }
      },
    );
    replace.immediate(workers);
  }

  audit(event: RelayAuditEvent): void {
    this.database.prepare(`
      INSERT INTO relay_audit_events (
        occurred_at, event_type, role, node_id, connection_id, outcome,
        error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.occurredAt ?? new Date().toISOString(),
      event.eventType,
      event.role ?? null,
      event.nodeId ?? null,
      event.connectionId ?? null,
      event.outcome ?? null,
      event.errorCode ?? null,
    );
    this.pruneIfNeeded();
  }

  auditStream(stream: RelayStreamAudit): void {
    this.database.prepare(`
      INSERT INTO relay_stream_audit (
        occurred_at, stream_id, initiator_node_id, target_node_id, kind,
        method, path, status, bytes_to_initiator, bytes_to_receiver,
        duration_ms, outcome, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      stream.occurredAt ?? new Date().toISOString(),
      stream.streamId,
      stream.initiatorNodeId,
      stream.targetNodeId,
      stream.kind,
      stream.method ?? null,
      stream.path,
      stream.status ?? null,
      stream.bytesToInitiator,
      stream.bytesToReceiver,
      stream.durationMs,
      stream.outcome,
      stream.errorCode ?? null,
    );
    this.pruneIfNeeded();
  }

  prune(now = Date.now()): void {
    const cutoff = new Date(now - RELAY_AUDIT_RETENTION_AGE_MS).toISOString();
    const prune = this.database.transaction(() => {
      this.database.prepare(
        "DELETE FROM relay_audit_events WHERE occurred_at < ?",
      ).run(cutoff);
      this.database.prepare(
        "DELETE FROM relay_stream_audit WHERE occurred_at < ?",
      ).run(cutoff);
      this.database.prepare(`
        DELETE FROM relay_audit_events
        WHERE id NOT IN (
          SELECT id FROM relay_audit_events ORDER BY id DESC LIMIT ?
        )
      `).run(RELAY_AUDIT_RETENTION_ROWS);
      this.database.prepare(`
        DELETE FROM relay_stream_audit
        WHERE id NOT IN (
          SELECT id FROM relay_stream_audit ORDER BY id DESC LIMIT ?
        )
      `).run(RELAY_STREAM_RETENTION_ROWS);
    });
    prune.immediate();
    this.lastPrunedAt = now;
    this.writesSincePrune = 0;
  }

  private pruneIfNeeded(now = Date.now()): void {
    this.writesSincePrune += 1;
    if (
      this.writesSincePrune >= RELAY_PRUNE_WRITE_THRESHOLD
      || now - this.lastPrunedAt >= RELAY_PRUNE_INTERVAL_MS
    ) {
      this.prune(now);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.database.close();
  }
}

/**
 * Reset relay trust state only after the relay listener has been stopped.
 * Live-session revocation must be coordinated by the caller before invoking
 * this offline persistence operation.
 */
export function resetStoppedMeshRelayPairing(dataDir: string): void {
  const store = new MeshRelayStore(dataDir);
  try {
    store.resetPairing();
  } finally {
    store.close();
  }
}
