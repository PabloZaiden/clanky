import type { SshKeySource, SshPublicKey, WorkspaceSshKeyGrant } from "@/shared/ssh-key-access";
import { getDatabase } from "./database";

export interface StoredSshKeySource extends SshKeySource {
  hostFingerprint: string;
}
interface SourceRow {
  id: string;
  name: string;
  host_json: string;
  host_fingerprint: string;
  created_at: string;
}
interface KeyRow {
  id: string;
  source_id: string;
  public_key: string;
  fingerprint: string;
  comment: string;
  alias: string;
  created_at: string;
}
export function listSshKeySources(userId: string): StoredSshKeySource[] {
  const rows = getDatabase().query("SELECT * FROM ssh_key_sources WHERE user_id = ? ORDER BY created_at, id").all(userId) as SourceRow[];
  return rows.map((row) => ({
    id: row.id, name: row.name, host: JSON.parse(row.host_json) as SshKeySource["host"],
    hostFingerprint: row.host_fingerprint, createdAt: row.created_at,
  }));
}
export function saveSshKeySource(userId: string, source: StoredSshKeySource): void {
  getDatabase().run("INSERT INTO ssh_key_sources (id, user_id, name, host_json, host_fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [source.id, userId, source.name, JSON.stringify(source.host), source.hostFingerprint, source.createdAt]);
}
export function deleteSshKeySource(userId: string, sourceId: string): void {
  getDatabase().run("DELETE FROM ssh_key_sources WHERE id = ? AND user_id = ?", [sourceId, userId]);
}
export function listSshPublicKeys(userId: string): SshPublicKey[] {
  const rows = getDatabase().query("SELECT * FROM ssh_public_keys WHERE user_id = ? ORDER BY created_at, id").all(userId) as KeyRow[];
  return rows.map((row) => ({
    id: row.id, sourceId: row.source_id, publicKey: row.public_key, fingerprint: row.fingerprint,
    comment: row.comment, alias: row.alias, createdAt: row.created_at,
  }));
}
export function saveSshPublicKey(userId: string, key: SshPublicKey): void {
  getDatabase().run(`
    INSERT INTO ssh_public_keys (id, user_id, source_id, public_key, fingerprint, comment, alias, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id, fingerprint) DO UPDATE SET alias = excluded.alias, comment = excluded.comment
  `, [key.id, userId, key.sourceId, key.publicKey, key.fingerprint, key.comment, key.alias, key.createdAt]);
}
export function listSshKeyGrants(userId: string, scopeId: string): WorkspaceSshKeyGrant[] {
  const rows = getDatabase().query("SELECT key_id, enabled FROM ssh_workspace_key_grants WHERE user_id = ? AND scope_id = ? ORDER BY key_id")
    .all(userId, scopeId) as Array<{ key_id: string; enabled: number }>;
  return rows.map((row) => ({ keyId: row.key_id, enabled: row.enabled === 1 }));
}
export function setSshKeyGrant(userId: string, scopeId: string, keyId: string, enabled: boolean): void {
  getDatabase().run(`
    INSERT INTO ssh_workspace_key_grants (user_id, scope_id, key_id, enabled) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, scope_id, key_id) DO UPDATE SET enabled = excluded.enabled
  `, [userId, scopeId, keyId, enabled ? 1 : 0]);
}
export function transferSshKeyGrants(userId: string, fromScopeId: string, toScopeId: string): void {
  if (fromScopeId === toScopeId) return;
  const db = getDatabase();
  db.transaction(() => {
    for (const grant of listSshKeyGrants(userId, fromScopeId)) setSshKeyGrant(userId, toScopeId, grant.keyId, grant.enabled);
    db.run("DELETE FROM ssh_workspace_key_grants WHERE user_id = ? AND scope_id = ?", [userId, fromScopeId]);
  })();
}
export function replaceProvisioningSshKeyGrants(userId: string, scopeId: string, keyIds: readonly string[]): void {
  getDatabase().transaction(() => {
    deleteSshScopeGrants(userId, scopeId);
    for (const keyId of keyIds) setSshKeyGrant(userId, scopeId, keyId, true);
  })();
}
export function deleteSshScopeGrants(userId: string, scopeId: string): void {
  getDatabase().run("DELETE FROM ssh_workspace_key_grants WHERE user_id = ? AND scope_id = ?", [userId, scopeId]);
}
