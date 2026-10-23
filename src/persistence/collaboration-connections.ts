/**
 * User-bound connection metadata and encrypted pairing keys, never content.
 */

import { z } from "zod";
import type { CollaborationConnection } from "@/shared/collaboration";
import { COLLABORATION_MAX_CONNECTIONS } from "@/shared/collaboration";
import { CollaborationConnectionSchema } from "@/contracts/schemas/collaboration";
import { DomainError } from "../domain/domain-error";
import { getDatabase } from "./database";
import { getCollaborationOwner, parseCollaborationRecord } from "./collaboration-storage";

const ConnectionRowSchema = z.object({
  id: z.string(),
  protocol_version: z.literal(1),
  local_user_id: z.string(),
  name: z.string().nullable(),
  controller_node_id: z.string(),
  controller_public_key: z.string(),
  controller_fingerprint: z.string(),
  relay_url: z.string(),
  relay_fingerprint: z.string(),
  node_id: z.string(),
  public_key: z.string(),
  fingerprint: z.string(),
  private_key_ciphertext: z.string().min(1).nullable(),
  guest_id: z.string().nullable(),
  status: z.enum(["pending", "active", "revoked"]),
  created_at: z.string(),
  pending_expires_at: z.string(),
});

function decodeConnection(value: unknown): CollaborationConnection {
  const row = parseCollaborationRecord(ConnectionRowSchema, value);
  return parseCollaborationRecord(CollaborationConnectionSchema, {
    id: row.id,
    protocolVersion: row.protocol_version,
    name: row.name,
    controller: { nodeId: row.controller_node_id, publicKey: row.controller_public_key,
      fingerprint: row.controller_fingerprint },
    identity: { nodeId: row.node_id, publicKey: row.public_key, fingerprint: row.fingerprint },
    relayUrl: row.relay_url,
    relayFingerprint: row.relay_fingerprint,
    guestId: row.guest_id,
    status: row.status,
    createdAt: row.created_at,
    pendingExpiresAt: row.pending_expires_at,
  });
}

export function insertCollaborationConnection(
  localUserId: string,
  connection: CollaborationConnection,
  privateKeyCiphertext: string,
): void {
  const db = getDatabase();
  db.transaction(() => {
    if (!getCollaborationOwner(localUserId)) {
      throw new DomainError("collaboration_user_unavailable", "The local user is unavailable.");
    }
    const count = parseCollaborationRecord(z.object({ count: z.number().int() }),
      db.query("SELECT count(*) AS count FROM collaboration_connections WHERE local_user_id = ?").get(localUserId));
    if (count.count >= COLLABORATION_MAX_CONNECTIONS) {
      throw new DomainError("collaboration_connection_limit", "Remove an unused connection before creating another.");
    }
    db.query(`
      INSERT INTO collaboration_connections
        (id, local_user_id, protocol_version, name, controller_node_id, controller_public_key, controller_fingerprint,
         relay_url, relay_fingerprint, node_id, public_key, fingerprint, private_key_ciphertext,
         guest_id, status, created_at, pending_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?)
    `).run(connection.id, localUserId, connection.protocolVersion, connection.name, connection.controller.nodeId,
      connection.controller.publicKey, connection.controller.fingerprint,
      connection.relayUrl, connection.relayFingerprint, connection.identity.nodeId,
      connection.identity.publicKey, connection.identity.fingerprint, privateKeyCiphertext,
      connection.createdAt, connection.pendingExpiresAt);
  }).immediate();
}

export function getCollaborationConnection(
  localUserId: string,
  connectionId: string,
): CollaborationConnection | undefined {
  const row = getDatabase().query(`
    SELECT connection.* FROM collaboration_connections connection
    JOIN webapp_users owner ON owner.id = connection.local_user_id AND owner.disabled_at IS NULL
    WHERE connection.id = ? AND connection.local_user_id = ?
  `).get(connectionId, localUserId);
  return row ? decodeConnection(row) : undefined;
}

export function requireCollaborationConnection(localUserId: string, connectionId: string): CollaborationConnection {
  const connection = getCollaborationConnection(localUserId, connectionId);
  if (!connection) {
    throw new DomainError("collaboration_connection_not_found", "Connection not found.");
  }
  return connection;
}

export function listCollaborationConnections(localUserId: string): CollaborationConnection[] {
  return getDatabase().query(`
    SELECT connection.* FROM collaboration_connections connection
    JOIN webapp_users owner ON owner.id = connection.local_user_id AND owner.disabled_at IS NULL
    WHERE connection.local_user_id = ? ORDER BY connection.created_at, connection.id
  `).all(localUserId).map(decodeConnection);
}

export function listActiveCollaborationConnectionsInternal(): {
  localUserId: string;
  connection: CollaborationConnection;
}[] {
  return getDatabase().query(`
    SELECT connection.* FROM collaboration_connections connection
    JOIN webapp_users owner ON owner.id = connection.local_user_id AND owner.disabled_at IS NULL
    WHERE connection.status = 'active' ORDER BY connection.id
  `).all().map((value) => ({
    localUserId: parseCollaborationRecord(ConnectionRowSchema, value).local_user_id,
    connection: decodeConnection(value),
  }));
}

export function activateCollaborationConnection(
  localUserId: string,
  connectionId: string,
  guestId: string,
  now: string,
): CollaborationConnection {
  const db = getDatabase();
  return db.transaction(() => {
    const connection = requireCollaborationConnection(localUserId, connectionId);
    if (connection.status === "revoked"
      || (connection.status === "pending" && connection.pendingExpiresAt <= now)
      || (connection.guestId !== null && connection.guestId !== guestId)) {
      throw new DomainError("collaboration_connection_inactive", "The connection can no longer be activated.");
    }
    db.query(`
      UPDATE collaboration_connections SET status = 'active', guest_id = ?
      WHERE id = ? AND local_user_id = ?
    `).run(guestId, connectionId, localUserId);
    return requireCollaborationConnection(localUserId, connectionId);
  }).immediate();
}

export function getCollaborationConnectionCiphertextInternal(
  localUserId: string,
  connectionId: string,
  now: string,
): string {
  const connection = requireCollaborationConnection(localUserId, connectionId);
  if (connection.status === "revoked"
    || (connection.status === "pending" && connection.pendingExpiresAt <= now)) {
    throw new DomainError("collaboration_connection_inactive", "The connection identity is no longer available.");
  }
  const value = getDatabase().query(`
    SELECT private_key_ciphertext FROM collaboration_connections WHERE id = ? AND local_user_id = ?
  `).get(connectionId, localUserId);
  return parseCollaborationRecord(z.object({ private_key_ciphertext: z.string().min(1) }), value)
    .private_key_ciphertext;
}

export function revokeCollaborationConnection(localUserId: string, connectionId: string): void {
  requireCollaborationConnection(localUserId, connectionId);
  getDatabase().query(`
    UPDATE collaboration_connections SET status = 'revoked', private_key_ciphertext = NULL
    WHERE id = ? AND local_user_id = ?
  `).run(connectionId, localUserId);
}

export function deleteCollaborationConnection(localUserId: string, connectionId: string): void {
  requireCollaborationConnection(localUserId, connectionId);
  getDatabase().query("DELETE FROM collaboration_connections WHERE id = ? AND local_user_id = ?")
    .run(connectionId, localUserId);
}
