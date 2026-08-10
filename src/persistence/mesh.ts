/**
 * Persistence for linked-instance mesh membership and pairing state.
 *
 * This module stores public node metadata and local link ownership only.
 * Private node keys are handled by mesh-node-identity.ts.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import type {
  MeshLinkMemberRecord,
  MeshLinkRecord,
  MeshLinkStatus,
  MeshMemberStatus,
  MeshNodeRecord,
  MeshPairingApprovalRecord,
  MeshPairingMemberRecord,
  MeshPairingApprovalStatus,
  MeshPairingDirection,
  MeshPairingRequestRecord,
  MeshPairingStatus,
  MeshTakeoverClaimRecord,
  MeshTakeoverRecord,
  MeshTransport,
} from "@/shared/mesh";
import { DomainError } from "../domain/domain-error";
import {
  decideApproveMeshPairing,
  decideCompleteOutgoingMeshPairing,
  decideLocalMeshTakeover,
  decideRejectMeshPairing,
  decideRemoteMeshTakeover,
} from "../domain/mesh-transitions";
import { getDatabase } from "./database";
import {
  normalizeMeshInstanceName,
  validateMeshEncryptionPublicKey,
} from "./mesh-node-identity";

const log = createLogger("persistence:mesh");

function markExpiredPairingRequestAndRethrow(
  db: ReturnType<typeof getDatabase>,
  requestId: string,
  now: string,
  error: unknown,
): never {
  if (error instanceof DomainError && error.code === "mesh_pairing_request_expired") {
    db.run(`
      UPDATE mesh_pairing_requests
      SET status = 'expired', updated_at = ?
      WHERE id = ?
    `, [now, requestId]);
  }
  throw error;
}

interface MeshNodeRow {
  node_id: string;
  instance_name: string | null;
  public_key: string;
  fingerprint: string;
  encryption_public_key: string | null;
  endpoint: string | null;
  transport: MeshTransport;
  status: MeshMemberStatus;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MeshLinkRow {
  link_id: string;
  local_user_id: string;
  active_node_id: string | null;
  takeover_generation: number;
  active_claimed_at: string | null;
  active_claim_origin: string | null;
  status: MeshLinkStatus;
  created_at: string;
  updated_at: string;
}

interface MeshLinkMemberRow {
  link_id: string;
  node_id: string;
  instance_name?: string | null;
  local_user_id: string;
  endpoint: string | null;
  transport: MeshTransport;
  status: MeshMemberStatus;
  membership_generation: number;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MeshPairingRequestRow {
  id: string;
  direction: MeshPairingDirection;
  link_id: string | null;
  target_link_id: string | null;
  target_local_user_id: string | null;
  requested_node_id: string;
  requested_instance_name: string | null;
  requested_local_user_id: string;
  requested_username: string | null;
  endpoint: string;
  transport: MeshTransport;
  public_key: string;
  fingerprint: string;
  encryption_public_key: string | null;
  nonce: string;
  signature: string;
  status: MeshPairingStatus;
  expires_at: string;
  approved_at: string | null;
  approved_by_user_id: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface MeshPairingApprovalRow {
  request_id: string;
  link_id: string;
  approved_by_node_id: string;
  approved_by_instance_name: string | null;
  approved_by_local_user_id: string;
  active_node_id: string | null;
  takeover_generation: number;
  endpoint: string;
  transport: MeshTransport;
  public_key: string;
  fingerprint: string;
  encryption_public_key: string | null;
  signature: string;
  members_json: string | null;
  status: MeshPairingApprovalStatus;
  created_at: string;
  updated_at: string;
}

export interface SaveMeshNodeInput {
  nodeId: string;
  instanceName?: string | null;
  publicKey: string;
  fingerprint: string;
  encryptionPublicKey?: string;
  endpoint: string | null;
  transport: MeshTransport;
  status?: MeshMemberStatus;
}

export interface CreateMeshLinkInput {
  linkId?: string;
  localUserId: string;
  localNodeId: string;
  localNodeEndpoint: string | null;
  localNodeTransport: MeshTransport;
}

export interface CreateMeshPairingRequestInput {
  id?: string;
  direction?: MeshPairingDirection;
  nodeStatus?: MeshMemberStatus;
  linkId?: string | null;
  targetLocalUserId?: string | null;
  requestedNodeId: string;
  requestedInstanceName?: string | null;
  requestedLocalUserId: string;
  requestedUsername?: string | null;
  endpoint: string;
  transport: MeshTransport;
  publicKey: string;
  fingerprint: string;
  encryptionPublicKey?: string;
  nonce: string;
  signature: string;
  expiresAt: string;
}

export interface MeshPairingApprovalRollback {
  requestId: string;
  linkId: string;
  nodeId: string;
  approvingUserId: string;
  createdLink: boolean;
  previousRequest: {
    linkId: string | null;
    targetLinkId: string | null;
    targetLocalUserId: string | null;
    status: MeshPairingStatus;
    approvedAt: string | null;
    approvedByUserId: string | null;
    rejectionReason: string | null;
  };
  previousMember: MeshLinkMemberRecord | null;
  previousNode: MeshNodeRecord | null;
}

export interface ApproveMeshPairingRequestResult {
  link: MeshLinkRecord;
  rollback: MeshPairingApprovalRollback | null;
}

export interface SaveMeshPairingApprovalInput {
  requestId: string;
  linkId: string;
  approvedByNodeId: string;
  approvedByInstanceName?: string | null;
  approvedByLocalUserId: string;
  activeNodeId: string | null;
  takeoverGeneration: number;
  endpoint: string;
  transport: MeshTransport;
  publicKey: string;
  fingerprint: string;
  encryptionPublicKey?: string;
  signature: string;
  members?: MeshPairingMemberRecord[];
}

function parsePairingMembers(value: string | null): MeshPairingMemberRecord[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("members is not an array");
    }
    return parsed as MeshPairingMemberRecord[];
  } catch (error) {
    throw new DomainError("mesh_pairing_approval_invalid", "The stored pairing approval members are invalid.", {
      cause: error,
    });
  }
}

function serializePairingMembers(members: MeshPairingMemberRecord[] | undefined): string {
  try {
    return JSON.stringify(members ?? []);
  } catch (error) {
    throw new DomainError("mesh_pairing_approval_invalid", "The pairing approval members could not be serialized.", {
      cause: error,
    });
  }
}

function nodeFromRow(row: MeshNodeRow): MeshNodeRecord {
  return {
    nodeId: row.node_id,
    instanceName: row.instance_name ?? null,
    publicKey: row.public_key,
    fingerprint: row.fingerprint,
    encryptionPublicKey: row.encryption_public_key ?? undefined,
    endpoint: row.endpoint,
    transport: row.transport,
    status: row.status,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function linkFromRow(row: MeshLinkRow): MeshLinkRecord {
  return {
    linkId: row.link_id,
    localUserId: row.local_user_id,
    activeNodeId: row.active_node_id,
    takeoverGeneration: row.takeover_generation,
    activeClaimedAt: row.active_claimed_at ?? null,
    activeClaimOrigin: row.active_claim_origin ?? null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function memberFromRow(row: MeshLinkMemberRow): MeshLinkMemberRecord {
  return {
    linkId: row.link_id,
    nodeId: row.node_id,
    instanceName: row.instance_name ?? null,
    localUserId: row.local_user_id,
    endpoint: row.endpoint,
    transport: row.transport,
    status: row.status,
    membershipGeneration: row.membership_generation,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pairingRequestFromRow(row: MeshPairingRequestRow): MeshPairingRequestRecord {
  return {
    id: row.id,
    direction: row.direction,
    linkId: row.link_id ?? row.target_link_id,
    targetLocalUserId: row.target_local_user_id,
    requestedNodeId: row.requested_node_id,
    requestedInstanceName: row.requested_instance_name ?? null,
    requestedLocalUserId: row.requested_local_user_id,
    requestedUsername: row.requested_username,
    endpoint: row.endpoint,
    transport: row.transport,
    publicKey: row.public_key,
    fingerprint: row.fingerprint,
    encryptionPublicKey: row.encryption_public_key ?? undefined,
    nonce: row.nonce,
    signature: row.signature,
    status: row.status,
    expiresAt: row.expires_at,
    approvedAt: row.approved_at,
    approvedByUserId: row.approved_by_user_id,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pairingApprovalFromRow(row: MeshPairingApprovalRow): MeshPairingApprovalRecord {
  return {
    requestId: row.request_id,
    linkId: row.link_id,
    approvedByNodeId: row.approved_by_node_id,
    approvedByInstanceName: row.approved_by_instance_name ?? null,
    approvedByLocalUserId: row.approved_by_local_user_id,
    activeNodeId: row.active_node_id,
    takeoverGeneration: row.takeover_generation,
    endpoint: row.endpoint,
    transport: row.transport,
    publicKey: row.public_key,
    fingerprint: row.fingerprint,
    encryptionPublicKey: row.encryption_public_key ?? undefined,
    signature: row.signature,
    status: row.status,
    members: parsePairingMembers(row.members_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function saveMeshNode(input: SaveMeshNodeInput): Promise<MeshNodeRecord> {
  const db = getDatabase();
  const instanceName = input.instanceName === undefined || input.instanceName === null
    ? input.instanceName
    : normalizeMeshInstanceName(input.instanceName);
  if (input.encryptionPublicKey !== undefined) {
    validateMeshEncryptionPublicKey(input.encryptionPublicKey);
  }
  const existing = await getMeshNode(input.nodeId);
  if (existing && (
    existing.publicKey !== input.publicKey
    || existing.fingerprint !== input.fingerprint
    || (
      input.encryptionPublicKey !== undefined
      && existing.encryptionPublicKey !== undefined
      && existing.encryptionPublicKey !== input.encryptionPublicKey
    )
  )) {
    throw new DomainError(
      "mesh_peer_identity_mismatch",
      "The mesh node identity does not match the existing node record.",
      { details: { nodeId: input.nodeId } },
    );
  }
  const now = new Date().toISOString();
  db.run(`
    INSERT INTO mesh_nodes (
      node_id, instance_name, public_key, fingerprint, encryption_public_key, endpoint, transport, status,
      last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT(node_id) DO UPDATE SET
      instance_name = COALESCE(excluded.instance_name, mesh_nodes.instance_name),
      public_key = excluded.public_key,
      fingerprint = excluded.fingerprint,
      encryption_public_key = COALESCE(excluded.encryption_public_key, mesh_nodes.encryption_public_key),
      endpoint = COALESCE(excluded.endpoint, mesh_nodes.endpoint),
      transport = excluded.transport,
      status = CASE
        WHEN mesh_nodes.status = 'revoked' THEN 'revoked'
        WHEN mesh_nodes.status = 'active' AND excluded.status IN ('pending', 'offline') THEN 'active'
        ELSE excluded.status
      END,
      updated_at = excluded.updated_at
  `, [
    input.nodeId,
    instanceName ?? null,
    input.publicKey,
    input.fingerprint,
    input.encryptionPublicKey ?? null,
    input.endpoint,
    input.transport,
    input.status ?? "pending",
    now,
    now,
  ]);
  const node = await getMeshNode(input.nodeId);
  if (!node) {
    throw new Error(`Mesh node was not persisted: ${input.nodeId}`);
  }
  return node;
}

export async function getMeshNode(nodeId: string): Promise<MeshNodeRecord | null> {
  const row = getDatabase().query(`
    SELECT node_id, instance_name, public_key, fingerprint, encryption_public_key, endpoint, transport, status,
      last_seen_at, created_at, updated_at
    FROM mesh_nodes
    WHERE node_id = ?
  `).get(nodeId) as MeshNodeRow | null;
  return row ? nodeFromRow(row) : null;
}

export async function listMeshNodes(): Promise<MeshNodeRecord[]> {
  const rows = getDatabase().query(`
    SELECT node_id, instance_name, public_key, fingerprint, encryption_public_key, endpoint, transport, status,
      last_seen_at, created_at, updated_at
    FROM mesh_nodes
    ORDER BY created_at ASC, node_id ASC
  `).all() as MeshNodeRow[];
  return rows.map(nodeFromRow);
}

export async function createMeshLink(input: CreateMeshLinkInput): Promise<MeshLinkRecord> {
  const db = getDatabase();
  const linkId = input.linkId ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    db.run(`
      INSERT INTO mesh_links (
        link_id, local_user_id, active_node_id, takeover_generation,
        active_claimed_at, active_claim_origin,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, 0, ?, ?, 'active', ?, ?)
    `, [linkId, input.localUserId, input.localNodeId, now, "create", now, now]);
    db.run(`
      INSERT INTO mesh_link_members (
        link_id, node_id, local_user_id, endpoint, transport, status,
        membership_generation, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)
    `, [
      linkId,
      input.localNodeId,
      input.localUserId,
      input.localNodeEndpoint,
      input.localNodeTransport,
      now,
      now,
      now,
    ]);
  });
  transaction();
  const link = await getMeshLinkForUser(linkId, input.localUserId);
  if (!link) {
    throw new Error(`Mesh link was not persisted: ${linkId}`);
  }
  return link;
}

export async function getMeshLinkForUser(
  linkId: string,
  localUserId: string,
): Promise<MeshLinkRecord | null> {
  const row = getDatabase().query(`
    SELECT link_id, local_user_id, active_node_id, takeover_generation,
      active_claimed_at, active_claim_origin,
      status, created_at, updated_at
    FROM mesh_links
    WHERE link_id = ? AND local_user_id = ?
  `).get(linkId, localUserId) as MeshLinkRow | null;
  return row ? linkFromRow(row) : null;
}

export async function getMeshLinkById(linkId: string): Promise<MeshLinkRecord | null> {
  const row = getDatabase().query(`
    SELECT link_id, local_user_id, active_node_id, takeover_generation,
      active_claimed_at, active_claim_origin,
      status, created_at, updated_at
    FROM mesh_links
    WHERE link_id = ?
  `).get(linkId) as MeshLinkRow | null;
  return row ? linkFromRow(row) : null;
}

export async function getMeshLinkForLocalUser(localUserId: string): Promise<MeshLinkRecord | null> {
  const row = getDatabase().query(`
    SELECT link_id, local_user_id, active_node_id, takeover_generation,
      active_claimed_at, active_claim_origin,
      status, created_at, updated_at
    FROM mesh_links
    WHERE local_user_id = ?
  `).get(localUserId) as MeshLinkRow | null;
  return row ? linkFromRow(row) : null;
}

export async function listMeshLinksForLocalUser(localUserId: string): Promise<MeshLinkRecord[]> {
  const rows = getDatabase().query(`
    SELECT link_id, local_user_id, active_node_id, takeover_generation,
      active_claimed_at, active_claim_origin,
      status, created_at, updated_at
    FROM mesh_links
    WHERE local_user_id = ?
    ORDER BY created_at ASC, link_id ASC
  `).all(localUserId) as MeshLinkRow[];
  return rows.map(linkFromRow);
}

export async function claimMeshLinkForLocalUser(input: {
  linkId: string;
  localUserId: string;
  nodeId: string;
  claimOrigin: string;
  expectedGeneration?: number;
}): Promise<MeshTakeoverRecord> {
  const db = getDatabase();
  const now = new Date().toISOString();
  let claim: MeshTakeoverRecord | undefined;
  const transaction = db.transaction(() => {
    const linkRow = db.query(`
      SELECT link_id, local_user_id, active_node_id, takeover_generation,
        active_claimed_at, active_claim_origin, status, created_at, updated_at
      FROM mesh_links
      WHERE link_id = ? AND local_user_id = ?
    `).get(input.linkId, input.localUserId) as MeshLinkRow | null;
    const member = db.query(`
      SELECT status
      FROM mesh_link_members
      WHERE link_id = ? AND node_id = ?
    `).get(input.linkId, input.nodeId) as { status: MeshMemberStatus } | null;
    const decision = decideLocalMeshTakeover({
      link: linkRow ? linkFromRow(linkRow) : null,
      member,
      nodeId: input.nodeId,
      expectedGeneration: input.expectedGeneration,
    });
    const generation = decision.generation;
    db.run(`
      UPDATE mesh_links
      SET active_node_id = ?,
          takeover_generation = ?,
          active_claimed_at = ?,
          active_claim_origin = ?,
          status = 'active',
          updated_at = ?
      WHERE link_id = ? AND local_user_id = ?
    `, [
      input.nodeId,
      generation,
      now,
      input.claimOrigin,
      now,
      input.linkId,
      input.localUserId,
    ]);
    const claimId = crypto.randomUUID();
    db.run(`
      INSERT INTO mesh_link_claims (
        claim_id, link_id, node_id, generation, claimed_at,
        claim_origin, signature, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'active', ?)
      ON CONFLICT(link_id, generation, node_id) DO UPDATE SET
        claimed_at = excluded.claimed_at,
        claim_origin = excluded.claim_origin,
        status = 'active'
    `, [claimId, input.linkId, input.nodeId, generation, now, input.claimOrigin, now]);
    db.run(`
      UPDATE mesh_link_claims
      SET status = 'superseded'
      WHERE link_id = ? AND generation < ? AND status = 'active'
    `, [input.linkId, generation]);
    claim = {
      linkId: input.linkId,
      nodeId: input.nodeId,
      generation,
      claimedAt: now,
      claimOrigin: input.claimOrigin,
      signature: null,
    };
  });
  transaction();
  if (!claim) {
    throw new Error("Mesh takeover claim was not persisted.");
  }
  return claim;
}

export async function applyMeshLinkTakeover(input: {
  linkId: string;
  nodeId: string;
  generation: number;
  claimedAt: string;
  claimOrigin: string;
  signature: string;
}): Promise<MeshTakeoverRecord> {
  const db = getDatabase();
  let claim: MeshTakeoverRecord | undefined;
  let conflictError: DomainError | undefined;
  const transaction = db.transaction(() => {
    const linkRow = db.query(`
      SELECT link_id, local_user_id, active_node_id, takeover_generation,
        active_claimed_at, active_claim_origin, status, created_at, updated_at
      FROM mesh_links
      WHERE link_id = ?
    `).get(input.linkId) as MeshLinkRow | null;
    const member = db.query(`
      SELECT status
      FROM mesh_link_members
      WHERE link_id = ? AND node_id = ?
    `).get(input.linkId, input.nodeId) as { status: MeshMemberStatus } | null;
    const decision = decideRemoteMeshTakeover({
      link: linkRow ? linkFromRow(linkRow) : null,
      member,
      nodeId: input.nodeId,
      generation: input.generation,
      claimedAt: input.claimedAt,
      claimOrigin: input.claimOrigin,
      signature: input.signature,
    });
    const claimId = crypto.randomUUID();
    if (decision.kind === "conflict") {
      db.run(`
        INSERT INTO mesh_link_claims (
          claim_id, link_id, node_id, generation, claimed_at,
          claim_origin, signature, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'conflict', ?)
        ON CONFLICT(link_id, generation, node_id) DO UPDATE SET
          claimed_at = excluded.claimed_at,
          claim_origin = excluded.claim_origin,
          signature = excluded.signature,
          status = 'conflict'
      `, [claimId, input.linkId, input.nodeId, input.generation, input.claimedAt, input.claimOrigin, input.signature, input.claimedAt]);
      db.run(`
        UPDATE mesh_links
        SET status = 'conflict', updated_at = ?
        WHERE link_id = ?
      `, [input.claimedAt, input.linkId]);
      conflictError = decision.error;
      return;
    }
    if (decision.kind === "stale") {
      claim = decision.claim;
      return;
    }
    db.run(`
      UPDATE mesh_links
      SET active_node_id = ?,
          takeover_generation = ?,
          active_claimed_at = ?,
          active_claim_origin = ?,
          status = 'active',
          updated_at = ?
      WHERE link_id = ?
    `, [
      input.nodeId,
      input.generation,
      input.claimedAt,
      input.claimOrigin,
      input.claimedAt,
      input.linkId,
    ]);
    db.run(`
      INSERT INTO mesh_link_claims (
        claim_id, link_id, node_id, generation, claimed_at,
        claim_origin, signature, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
      ON CONFLICT(link_id, generation, node_id) DO UPDATE SET
        claimed_at = excluded.claimed_at,
        claim_origin = excluded.claim_origin,
        signature = excluded.signature,
        status = 'active'
    `, [claimId, input.linkId, input.nodeId, input.generation, input.claimedAt, input.claimOrigin, input.signature, input.claimedAt]);
    db.run(`
      UPDATE mesh_link_claims
      SET status = 'superseded'
      WHERE link_id = ? AND generation < ? AND status = 'active'
    `, [input.linkId, input.generation]);
    claim = {
      linkId: input.linkId,
      nodeId: input.nodeId,
      generation: input.generation,
      claimedAt: input.claimedAt,
      claimOrigin: input.claimOrigin,
      signature: input.signature,
    };
  });
  transaction();
  if (conflictError) {
    throw conflictError;
  }
  if (!claim) {
    throw new Error("Mesh takeover claim was not applied.");
  }
  return claim;
}

export async function setMeshLinkTakeoverSignature(input: {
  linkId: string;
  nodeId: string;
  generation: number;
  signature: string;
}): Promise<void> {
  const result = getDatabase().run(`
    UPDATE mesh_link_claims
    SET signature = ?
    WHERE link_id = ? AND node_id = ? AND generation = ? AND status = 'active'
  `, [input.signature, input.linkId, input.nodeId, input.generation]);
  if (result.changes === 0) {
    throw new DomainError("mesh_takeover_claim_not_found", "The mesh takeover claim was not found.");
  }
}

export async function getActiveMeshLinkTakeover(
  linkId: string,
): Promise<MeshTakeoverClaimRecord | null> {
  const row = getDatabase().query(`
    SELECT claim.link_id, claim.node_id, claim.generation, claim.claimed_at,
      claim.claim_origin, claim.signature, node.public_key, node.fingerprint
    FROM mesh_link_claims AS claim
    JOIN mesh_links AS link
      ON link.link_id = claim.link_id
      AND link.active_node_id = claim.node_id
      AND link.takeover_generation = claim.generation
    JOIN mesh_nodes AS node ON node.node_id = claim.node_id
    WHERE claim.link_id = ? AND claim.status = 'active'
    ORDER BY claim.created_at DESC
    LIMIT 1
  `).get(linkId) as {
    link_id: string;
    node_id: string;
    generation: number;
    claimed_at: string;
    claim_origin: string;
    signature: string | null;
    public_key: string;
    fingerprint: string;
  } | null;
  if (!row) {
    return null;
  }
  return {
    linkId: row.link_id,
    nodeId: row.node_id,
    generation: row.generation,
    claimedAt: row.claimed_at,
    claimOrigin: row.claim_origin,
    signature: row.signature,
    publicKey: row.public_key,
    fingerprint: row.fingerprint,
  };
}

export async function listMeshLinkMembers(linkId: string): Promise<MeshLinkMemberRecord[]> {
  const rows = getDatabase().query(`
    SELECT member.link_id, member.node_id, node.instance_name, member.local_user_id,
      member.endpoint, member.transport, member.status, member.membership_generation,
      member.last_seen_at, member.created_at, member.updated_at
    FROM mesh_link_members AS member
    LEFT JOIN mesh_nodes AS node ON node.node_id = member.node_id
    WHERE member.link_id = ?
    ORDER BY member.created_at ASC, member.node_id ASC
  `).all(linkId) as MeshLinkMemberRow[];
  return rows.map(memberFromRow);
}

export async function getMeshLinkMembershipSnapshot(
  linkId: string,
): Promise<MeshPairingMemberRecord[]> {
  const members = await listMeshLinkMembers(linkId);
  const snapshots: MeshPairingMemberRecord[] = [];
  for (const member of members) {
    const node = await getMeshNode(member.nodeId);
    if (!node) {
      throw new DomainError("mesh_peer_not_found", "A mesh link member has no node identity.");
    }
    snapshots.push({
      nodeId: member.nodeId,
      instanceName: node.instanceName,
      localUserId: member.localUserId,
      endpoint: member.endpoint,
      transport: member.transport,
      status: member.status,
      membershipGeneration: member.membershipGeneration,
      publicKey: node.publicKey,
      fingerprint: node.fingerprint,
      encryptionPublicKey: node.encryptionPublicKey,
    });
  }
  return snapshots;
}

export async function applyMeshLinkMembershipSnapshot(
  linkId: string,
  members: MeshPairingMemberRecord[],
): Promise<void> {
  if (!await getMeshLinkById(linkId)) {
    throw new DomainError("mesh_link_not_found", "The mesh link was not found.");
  }
  for (const member of members) {
    await mergeMeshLinkMember({
      linkId,
      nodeId: member.nodeId,
      instanceName: member.instanceName,
      localUserId: member.localUserId,
      endpoint: member.endpoint,
      transport: member.transport,
      status: member.status,
      membershipGeneration: member.membershipGeneration,
      publicKey: member.publicKey,
      fingerprint: member.fingerprint,
      encryptionPublicKey: member.encryptionPublicKey,
    });
  }
}

export async function revokeMeshLinkMember(input: {
  linkId: string;
  localUserId: string;
  nodeId: string;
}): Promise<MeshLinkMemberRecord> {
  const db = getDatabase();
  const now = new Date().toISOString();
  let revoked: MeshLinkMemberRecord | undefined;
  const transaction = db.transaction(() => {
    const link = db.query(`
      SELECT link_id, local_user_id, active_node_id, takeover_generation,
        active_claimed_at, active_claim_origin, status, created_at, updated_at
      FROM mesh_links
      WHERE link_id = ? AND local_user_id = ?
    `).get(input.linkId, input.localUserId) as MeshLinkRow | null;
    if (!link) {
      throw new DomainError("mesh_link_not_found", "The mesh link was not found.");
    }
    if (link.active_node_id === input.nodeId) {
      throw new DomainError(
        "mesh_active_node_revoke_requires_takeover",
        "The active mesh node must be replaced before it can be revoked.",
      );
    }
    const member = db.query(`
      SELECT link_id, node_id, local_user_id, endpoint, transport, status,
        membership_generation, last_seen_at, created_at, updated_at
      FROM mesh_link_members
      WHERE link_id = ? AND node_id = ?
    `).get(input.linkId, input.nodeId) as MeshLinkMemberRow | null;
    if (!member) {
      throw new DomainError("mesh_node_not_member", "The node is not a member of this mesh link.");
    }
    const generation = member.membership_generation + 1;
    db.run(`
      UPDATE mesh_link_members
      SET status = 'revoked', membership_generation = ?, updated_at = ?
      WHERE link_id = ? AND node_id = ?
    `, [generation, now, input.linkId, input.nodeId]);
    db.run(`
      UPDATE mesh_nodes
      SET status = 'revoked', updated_at = ?
      WHERE node_id = ?
    `, [now, input.nodeId]);
    db.run("DELETE FROM mesh_sync_outbox WHERE peer_node_id = ?", [input.nodeId]);
    revoked = {
      ...memberFromRow(member),
      status: "revoked",
      membershipGeneration: generation,
      updatedAt: now,
    };
  });
  transaction();
  if (!revoked) {
    throw new Error(`Mesh member was not revoked: ${input.nodeId}`);
  }
  return revoked;
}

export async function removeRevokedMeshLinkMember(input: {
  linkId: string;
  localUserId: string;
  nodeId: string;
}): Promise<MeshLinkMemberRecord> {
  const db = getDatabase();
  const now = new Date().toISOString();
  let removed: MeshLinkMemberRecord | undefined;
  const transaction = db.transaction(() => {
    const link = db.query(`
      SELECT link_id, local_user_id, active_node_id, takeover_generation,
        active_claimed_at, active_claim_origin, status, created_at, updated_at
      FROM mesh_links
      WHERE link_id = ? AND local_user_id = ?
    `).get(input.linkId, input.localUserId) as MeshLinkRow | null;
    if (!link) {
      throw new DomainError("mesh_link_not_found", "The mesh link was not found.");
    }
    const member = db.query(`
      SELECT link_id, node_id, local_user_id, endpoint, transport, status,
        membership_generation, last_seen_at, created_at, updated_at
      FROM mesh_link_members
      WHERE link_id = ? AND node_id = ?
    `).get(input.linkId, input.nodeId) as MeshLinkMemberRow | null;
    if (!member) {
      throw new DomainError("mesh_node_not_member", "The node is not a member of this mesh link.");
    }
    if (member.status !== "revoked") {
      throw new DomainError(
        "mesh_member_not_revoked",
        "Only a revoked mesh member can have its revocation deleted.",
      );
    }

    db.run(
      "DELETE FROM mesh_link_members WHERE link_id = ? AND node_id = ?",
      [input.linkId, input.nodeId],
    );
    db.run(
      "DELETE FROM mesh_sync_outbox WHERE peer_node_id = ? AND link_id = ?",
      [input.nodeId, input.linkId],
    );
    db.run(
      "DELETE FROM mesh_link_claims WHERE link_id = ? AND node_id = ?",
      [input.linkId, input.nodeId],
    );
    db.run(
      "DELETE FROM mesh_sync_conflicts WHERE link_id = ? AND origin_node_id = ?",
      [input.linkId, input.nodeId],
    );

    const remainingMembers = db.query(`
      SELECT status
      FROM mesh_link_members
      WHERE node_id = ?
    `).all(input.nodeId) as Array<{ status: MeshMemberStatus }>;
    const isActiveAuthority = db.query(`
      SELECT 1
      FROM mesh_links
      WHERE active_node_id = ?
      LIMIT 1
    `).get(input.nodeId) !== null;
    if (remainingMembers.length === 0 && !isActiveAuthority) {
      db.run("DELETE FROM mesh_nodes WHERE node_id = ?", [input.nodeId]);
    } else {
      const nextStatus: MeshMemberStatus = isActiveAuthority
        || remainingMembers.some((candidate) => candidate.status === "active")
        ? "active"
        : remainingMembers.some((candidate) => candidate.status === "pending")
          ? "pending"
          : remainingMembers.some((candidate) => candidate.status === "rejoining")
            ? "rejoining"
            : remainingMembers.some((candidate) => candidate.status === "offline")
              ? "offline"
              : "revoked";
      db.run(`
        UPDATE mesh_nodes
        SET status = ?, updated_at = ?
        WHERE node_id = ?
      `, [nextStatus, now, input.nodeId]);
    }
    removed = {
      ...memberFromRow(member),
      updatedAt: now,
    };
  });
  transaction();
  if (!removed) {
    throw new Error(`Revoked mesh member was not removed: ${input.nodeId}`);
  }
  log.info("Deleted mesh member revocation", {
    linkId: input.linkId,
    nodeId: input.nodeId,
  });
  return removed;
}

export async function markLocalMeshMemberRevoked(input: {
  linkId: string;
  nodeId: string;
}): Promise<void> {
  const db = getDatabase();
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    const member = db.query(`
      SELECT membership_generation
      FROM mesh_link_members
      WHERE link_id = ? AND node_id = ?
    `).get(input.linkId, input.nodeId) as { membership_generation: number } | null;
    if (!member) {
      return;
    }
    db.run(`
      UPDATE mesh_link_members
      SET status = 'revoked', membership_generation = ?, updated_at = ?
      WHERE link_id = ? AND node_id = ?
    `, [
      member.membership_generation + 1,
      now,
      input.linkId,
      input.nodeId,
    ]);
    db.run(`
      UPDATE mesh_nodes
      SET status = 'revoked', updated_at = ?
      WHERE node_id = ?
    `, [now, input.nodeId]);
    db.run("DELETE FROM mesh_sync_outbox WHERE peer_node_id = ? OR link_id = ?", [
      input.nodeId,
      input.linkId,
    ]);
  });
  transaction();
}

export async function mergeMeshLinkMember(input: {
  linkId: string;
  nodeId: string;
  instanceName?: string | null;
  localUserId: string;
  endpoint: string | null;
  transport: MeshTransport;
  status: MeshMemberStatus;
  membershipGeneration: number;
  publicKey: string;
  fingerprint: string;
  encryptionPublicKey?: string;
}): Promise<MeshLinkMemberRecord> {
  const link = await getMeshLinkById(input.linkId);
  if (!link) {
    throw new DomainError("mesh_link_not_found", "The mesh link was not found.");
  }
  await saveMeshNode({
    nodeId: input.nodeId,
    instanceName: input.instanceName,
    publicKey: input.publicKey,
    fingerprint: input.fingerprint,
    encryptionPublicKey: input.encryptionPublicKey,
    endpoint: input.endpoint,
    transport: input.transport,
    status: input.status,
  });
  const now = new Date().toISOString();
  getDatabase().run(`
    INSERT INTO mesh_link_members (
      link_id, node_id, local_user_id, endpoint, transport, status,
      membership_generation, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(link_id, node_id) DO UPDATE SET
      local_user_id = excluded.local_user_id,
      endpoint = COALESCE(excluded.endpoint, mesh_link_members.endpoint),
      transport = excluded.transport,
      status = CASE
        WHEN mesh_link_members.status = 'revoked' THEN 'revoked'
        ELSE excluded.status
      END,
      membership_generation = MAX(
        mesh_link_members.membership_generation,
        excluded.membership_generation
      ),
      last_seen_at = COALESCE(excluded.last_seen_at, mesh_link_members.last_seen_at),
      updated_at = excluded.updated_at
  `, [
    input.linkId,
    input.nodeId,
    input.localUserId,
    input.endpoint,
    input.transport,
    input.status,
    input.membershipGeneration,
    now,
    now,
    now,
  ]);
  const member = (await listMeshLinkMembers(input.linkId))
    .find((candidate) => candidate.nodeId === input.nodeId);
  if (!member) {
    throw new Error(`Mesh link member was not persisted: ${input.nodeId}`);
  }
  return member;
}

export async function createMeshPairingRequest(
  input: CreateMeshPairingRequestInput,
): Promise<MeshPairingRequestRecord> {
  const direction = input.direction ?? "incoming";
  await saveMeshNode({
    nodeId: input.requestedNodeId,
    instanceName: input.requestedInstanceName,
    publicKey: input.publicKey,
    fingerprint: input.fingerprint,
    encryptionPublicKey: input.encryptionPublicKey,
    endpoint: input.endpoint,
    transport: input.transport,
    status: input.nodeStatus ?? (direction === "outgoing" ? "active" : "pending"),
  });
  const id = input.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  getDatabase().run(`
    INSERT INTO mesh_pairing_requests (
      id, direction, link_id, target_link_id, target_local_user_id, requested_node_id,
      requested_instance_name, requested_local_user_id, requested_username, endpoint, transport,
      public_key, fingerprint, encryption_public_key, nonce, signature, status, expires_at,
      approved_at, approved_by_user_id, rejection_reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, ?, ?)
  `, [
    id,
    direction,
    direction === "incoming" ? null : input.linkId ?? null,
    direction === "incoming" ? input.linkId ?? null : null,
    input.targetLocalUserId ?? null,
    input.requestedNodeId,
    input.requestedInstanceName ?? null,
    input.requestedLocalUserId,
    input.requestedUsername ?? null,
    input.endpoint,
    input.transport,
    input.publicKey,
    input.fingerprint,
    input.encryptionPublicKey ?? null,
    input.nonce,
    input.signature,
    input.expiresAt,
    now,
    now,
  ]);
  const request = await getMeshPairingRequest(id);
  if (!request) {
    throw new Error(`Mesh pairing request was not persisted: ${id}`);
  }
  log.info("Created mesh pairing request", {
    requestId: id,
    requestedNodeId: input.requestedNodeId,
  });
  return request;
}

export async function getMeshPairingRequest(id: string): Promise<MeshPairingRequestRecord | null> {
  const row = getDatabase().query(`
    SELECT id, direction, link_id, target_link_id, target_local_user_id, requested_node_id,
      requested_instance_name, requested_local_user_id, requested_username, endpoint, transport,
      public_key, fingerprint, encryption_public_key, nonce, signature, status, expires_at,
      approved_at, approved_by_user_id, rejection_reason, created_at, updated_at
    FROM mesh_pairing_requests
    WHERE id = ?
  `).get(id) as MeshPairingRequestRow | null;
  return row ? pairingRequestFromRow(row) : null;
}

export async function getMeshPairingApproval(
  requestId: string,
): Promise<MeshPairingApprovalRecord | null> {
  const row = getDatabase().query(`
    SELECT request_id, link_id, approved_by_node_id, approved_by_local_user_id,
      approved_by_instance_name, active_node_id, takeover_generation, endpoint, transport, public_key,
      fingerprint, encryption_public_key, signature, members_json, status,
      created_at, updated_at
    FROM mesh_pairing_approvals
    WHERE request_id = ?
  `).get(requestId) as MeshPairingApprovalRow | null;
  return row ? pairingApprovalFromRow(row) : null;
}

export async function saveMeshPairingApproval(
  input: SaveMeshPairingApprovalInput,
): Promise<MeshPairingApprovalRecord> {
  const existing = await getMeshPairingApproval(input.requestId);
  if (existing) {
    if (
      existing.linkId !== input.linkId
      || existing.approvedByNodeId !== input.approvedByNodeId
      || existing.approvedByInstanceName !== (input.approvedByInstanceName ?? null)
      || existing.approvedByLocalUserId !== input.approvedByLocalUserId
      || existing.activeNodeId !== input.activeNodeId
      || existing.takeoverGeneration !== input.takeoverGeneration
      || existing.endpoint !== input.endpoint
      || existing.transport !== input.transport
      || existing.publicKey !== input.publicKey
      || existing.fingerprint !== input.fingerprint
      || existing.encryptionPublicKey !== input.encryptionPublicKey
      || existing.signature !== input.signature
      || JSON.stringify(existing.members) !== JSON.stringify(input.members ?? [])
    ) {
      throw new DomainError("mesh_pairing_approval_conflict", "The pairing approval ID is already used by another approval.");
    }
    return existing;
  }
  const now = new Date().toISOString();
  getDatabase().run(`
    INSERT INTO mesh_pairing_approvals (
      request_id, link_id, approved_by_node_id, approved_by_instance_name,
      approved_by_local_user_id, active_node_id, takeover_generation, endpoint, transport, public_key,
      fingerprint, encryption_public_key, signature, members_json, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(request_id) DO UPDATE SET
      link_id = excluded.link_id,
      approved_by_node_id = excluded.approved_by_node_id,
      approved_by_instance_name = excluded.approved_by_instance_name,
      approved_by_local_user_id = excluded.approved_by_local_user_id,
      active_node_id = excluded.active_node_id,
      takeover_generation = excluded.takeover_generation,
      endpoint = excluded.endpoint,
      transport = excluded.transport,
      public_key = excluded.public_key,
      fingerprint = excluded.fingerprint,
      encryption_public_key = excluded.encryption_public_key,
      signature = excluded.signature,
      members_json = excluded.members_json,
      status = CASE
        WHEN mesh_pairing_approvals.status = 'accepted' THEN 'accepted'
        ELSE 'pending'
      END,
      updated_at = excluded.updated_at
  `, [
    input.requestId,
    input.linkId,
    input.approvedByNodeId,
    input.approvedByInstanceName ?? null,
    input.approvedByLocalUserId,
    input.activeNodeId,
    input.takeoverGeneration,
    input.endpoint,
    input.transport,
    input.publicKey,
    input.fingerprint,
    input.encryptionPublicKey ?? null,
    input.signature,
    serializePairingMembers(input.members),
    now,
    now,
  ]);
  const approval = await getMeshPairingApproval(input.requestId);
  if (!approval) {
    throw new Error(`Mesh pairing approval was not persisted: ${input.requestId}`);
  }
  return approval;
}

export async function setMeshPairingApprovalStatus(
  requestId: string,
  status: Exclude<MeshPairingApprovalStatus, "pending">,
): Promise<MeshPairingApprovalRecord> {
  const now = new Date().toISOString();
  getDatabase().run(`
    UPDATE mesh_pairing_approvals
    SET status = ?, updated_at = ?
    WHERE request_id = ?
  `, [status, now, requestId]);
  const approval = await getMeshPairingApproval(requestId);
  if (!approval) {
    throw new DomainError("mesh_pairing_approval_not_found", "Mesh pairing approval was not found.");
  }
  return approval;
}

export async function listPendingMeshPairingRequests(
  localUserId: string,
): Promise<MeshPairingRequestRecord[]> {
  const rows = getDatabase().query(`
    SELECT request.id, request.link_id, request.target_link_id, request.target_local_user_id,
      request.direction,
      request.requested_node_id, request.requested_local_user_id,
      request.requested_instance_name, request.requested_username, request.endpoint, request.transport,
      request.public_key, request.fingerprint, request.encryption_public_key,
      request.nonce, request.signature,
      request.status, request.expires_at, request.approved_at,
      request.approved_by_user_id, request.rejection_reason,
      request.created_at, request.updated_at
    FROM mesh_pairing_requests AS request
    LEFT JOIN mesh_links AS link ON link.link_id = request.link_id
    WHERE request.status = 'pending'
      AND (
        (
          request.direction = 'incoming'
          AND (
            request.target_local_user_id = ?
            OR request.target_local_user_id IS NULL
            OR link.local_user_id = ?
          )
        )
        OR (
          request.direction = 'outgoing'
          AND request.requested_local_user_id = ?
        )
      )
    ORDER BY request.created_at ASC, request.id ASC
  `).all(localUserId, localUserId, localUserId) as MeshPairingRequestRow[];
  return rows.map(pairingRequestFromRow);
}

export async function approveMeshPairingRequest(input: {
  requestId: string;
  approvingUserId: string;
  localNodeId: string;
  localNodeEndpoint: string | null;
  localNodeTransport: MeshTransport;
  linkId?: string;
}): Promise<ApproveMeshPairingRequestResult> {
  const db = getDatabase();
  const now = new Date().toISOString();
  let resolvedLinkId: string | undefined;
  let rollback: MeshPairingApprovalRollback | null = null;
  const transaction = db.transaction(() => {
    const requestRow = db.query(`
      SELECT id, link_id, target_link_id, target_local_user_id, requested_node_id,
        requested_instance_name,
        direction,
        requested_local_user_id, requested_username, endpoint, transport,
        public_key, fingerprint, encryption_public_key, nonce, signature, status, expires_at,
        approved_at, approved_by_user_id, rejection_reason, created_at, updated_at
      FROM mesh_pairing_requests
      WHERE id = ?
    `).get(input.requestId) as MeshPairingRequestRow | null;
    const request = requestRow ? pairingRequestFromRow(requestRow) : null;

    const existingUserLinkRow = db.query(`
      SELECT link_id, local_user_id, active_node_id, takeover_generation,
        active_claimed_at, active_claim_origin, status, created_at, updated_at
      FROM mesh_links
      WHERE local_user_id = ?
    `).get(input.approvingUserId) as MeshLinkRow | null;
    const existingUserLink = existingUserLinkRow ? linkFromRow(existingUserLinkRow) : null;
    const candidateLinkId = request?.status === "approved" && request.linkId
      ? request.linkId
      : input.linkId
        ?? request?.linkId
      ?? existingUserLink?.linkId
      ?? crypto.randomUUID();
    const selectedLinkRow = db.query(`
      SELECT link_id, local_user_id, active_node_id, takeover_generation,
        active_claimed_at, active_claim_origin, status, created_at, updated_at
      FROM mesh_links
      WHERE link_id = ?
    `).get(candidateLinkId) as MeshLinkRow | null;
    const selectedLink = selectedLinkRow ? linkFromRow(selectedLinkRow) : null;
    let decision: ReturnType<typeof decideApproveMeshPairing>;
    try {
      decision = decideApproveMeshPairing({
        request,
        approvingUserId: input.approvingUserId,
        requestedLinkId: input.linkId,
        existingUserLink,
        selectedLink,
        generatedLinkId: candidateLinkId,
        nowMs: Date.now(),
      });
    } catch (error) {
      markExpiredPairingRequestAndRethrow(db, input.requestId, now, error);
    }
    if (decision.kind === "idempotent") {
      resolvedLinkId = decision.linkId;
      return;
    }
    const linkId = decision.linkId;
    const previousMemberRow = db.query(`
      SELECT link_id, node_id, local_user_id, endpoint, transport, status,
        membership_generation, last_seen_at, created_at, updated_at
      FROM mesh_link_members
      WHERE link_id = ? AND node_id = ?
    `).get(linkId, requestRow!.requested_node_id) as MeshLinkMemberRow | null;
    const previousNodeRow = db.query(`
      SELECT node_id, instance_name, public_key, fingerprint, encryption_public_key,
        endpoint, transport, status, last_seen_at, created_at, updated_at
      FROM mesh_nodes
      WHERE node_id = ?
    `).get(requestRow!.requested_node_id) as MeshNodeRow | null;
    rollback = {
      requestId: input.requestId,
      linkId,
      nodeId: requestRow!.requested_node_id,
      approvingUserId: input.approvingUserId,
      createdLink: decision.createLink,
      previousRequest: {
        linkId: requestRow!.link_id,
        targetLinkId: requestRow!.target_link_id,
        targetLocalUserId: requestRow!.target_local_user_id,
        status: requestRow!.status,
        approvedAt: requestRow!.approved_at,
        approvedByUserId: requestRow!.approved_by_user_id,
        rejectionReason: requestRow!.rejection_reason,
      },
      previousMember: previousMemberRow ? memberFromRow(previousMemberRow) : null,
      previousNode: previousNodeRow ? nodeFromRow(previousNodeRow) : null,
    };
    if (decision.createLink) {
      db.run(`
        INSERT INTO mesh_links (
          link_id, local_user_id, active_node_id, takeover_generation,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, 0, 'active', ?, ?)
      `, [linkId, input.approvingUserId, input.localNodeId, now, now]);
      db.run(`
        INSERT INTO mesh_link_members (
          link_id, node_id, local_user_id, endpoint, transport, status,
          membership_generation, last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)
      `, [
        linkId,
        input.localNodeId,
        input.approvingUserId,
        input.localNodeEndpoint,
        input.localNodeTransport,
        now,
        now,
        now,
      ]);
    }

    db.run(`
      INSERT INTO mesh_link_members (
        link_id, node_id, local_user_id, endpoint, transport, status,
        membership_generation, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)
      ON CONFLICT(link_id, node_id) DO UPDATE SET
        local_user_id = excluded.local_user_id,
        endpoint = excluded.endpoint,
        transport = excluded.transport,
        status = 'active',
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `, [
      linkId,
      requestRow!.requested_node_id,
      requestRow!.requested_local_user_id,
      requestRow!.endpoint,
      requestRow!.transport,
      now,
      now,
      now,
    ]);
    db.run(`
      UPDATE mesh_nodes
      SET status = 'active', endpoint = ?, transport = ?, updated_at = ?
      WHERE node_id = ?
    `, [requestRow!.endpoint, requestRow!.transport, now, requestRow!.requested_node_id]);
    db.run(`
      UPDATE mesh_pairing_requests
      SET link_id = ?, target_link_id = NULL, target_local_user_id = ?, status = 'approved',
        approved_at = ?, approved_by_user_id = ?, updated_at = ?
      WHERE id = ?
    `, [linkId, input.approvingUserId, now, input.approvingUserId, now, input.requestId]);
    resolvedLinkId = linkId;
  });
  transaction();
  if (!resolvedLinkId) {
    throw new Error(`Mesh pairing request did not resolve to a link: ${input.requestId}`);
  }
  const link = await getMeshLinkForUser(resolvedLinkId, input.approvingUserId);
  if (!link) {
    throw new Error(`Mesh link was not persisted after pairing approval: ${resolvedLinkId}`);
  }
  log.info("Approved mesh pairing request", {
    requestId: input.requestId,
    linkId: resolvedLinkId,
  });
  return { link, rollback };
}

export async function rollbackMeshPairingApproval(
  rollback: MeshPairingApprovalRollback,
): Promise<void> {
  const db = getDatabase();
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    const request = db.query(`
      SELECT id, link_id, status
      FROM mesh_pairing_requests
      WHERE id = ?
    `).get(rollback.requestId) as {
      id: string;
      link_id: string | null;
      status: MeshPairingStatus;
    } | null;
    if (!request) {
      throw new DomainError("mesh_pairing_request_not_found", "The mesh pairing request was not found.");
    }
    if (request.status !== "approved" || request.link_id !== rollback.linkId) {
      throw new DomainError(
        "mesh_pairing_rollback_conflict",
        "The mesh pairing approval changed before it could be rolled back.",
        {
          details: {
            requestId: rollback.requestId,
            linkId: rollback.linkId,
            currentStatus: request.status,
            currentLinkId: request.link_id,
          },
        },
      );
    }

    if (rollback.createdLink) {
      db.run(`
        DELETE FROM mesh_links
        WHERE link_id = ? AND local_user_id = ?
      `, [rollback.linkId, rollback.approvingUserId]);
    } else if (rollback.previousMember) {
      const member = rollback.previousMember;
      db.run(`
        INSERT INTO mesh_link_members (
          link_id, node_id, local_user_id, endpoint, transport, status,
          membership_generation, last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(link_id, node_id) DO UPDATE SET
          local_user_id = excluded.local_user_id,
          endpoint = excluded.endpoint,
          transport = excluded.transport,
          status = excluded.status,
          membership_generation = excluded.membership_generation,
          last_seen_at = excluded.last_seen_at,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `, [
        member.linkId,
        member.nodeId,
        member.localUserId,
        member.endpoint,
        member.transport,
        member.status,
        member.membershipGeneration,
        member.lastSeenAt,
        member.createdAt,
        member.updatedAt,
      ]);
    } else {
      db.run(`
        DELETE FROM mesh_link_members
        WHERE link_id = ? AND node_id = ?
      `, [rollback.linkId, rollback.nodeId]);
    }

    if (rollback.previousNode) {
      const node = rollback.previousNode;
      db.run(`
        INSERT INTO mesh_nodes (
          node_id, instance_name, public_key, fingerprint, encryption_public_key,
          endpoint, transport, status, last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET
          instance_name = excluded.instance_name,
          public_key = excluded.public_key,
          fingerprint = excluded.fingerprint,
          encryption_public_key = excluded.encryption_public_key,
          endpoint = excluded.endpoint,
          transport = excluded.transport,
          status = excluded.status,
          last_seen_at = excluded.last_seen_at,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `, [
        node.nodeId,
        node.instanceName,
        node.publicKey,
        node.fingerprint,
        node.encryptionPublicKey ?? null,
        node.endpoint,
        node.transport,
        node.status,
        node.lastSeenAt,
        node.createdAt,
        node.updatedAt,
      ]);
    }

    const previousRequest = rollback.previousRequest;
    db.run(`
      UPDATE mesh_pairing_requests
      SET link_id = ?, target_link_id = ?, target_local_user_id = ?, status = ?,
        approved_at = ?, approved_by_user_id = ?, rejection_reason = ?, updated_at = ?
      WHERE id = ?
    `, [
      previousRequest.linkId,
      previousRequest.targetLinkId,
      previousRequest.targetLocalUserId,
      previousRequest.status,
      previousRequest.approvedAt,
      previousRequest.approvedByUserId,
      previousRequest.rejectionReason,
      now,
      rollback.requestId,
    ]);
  });
  transaction();
  log.warn("Rolled back mesh pairing approval after delivery failure", {
    requestId: rollback.requestId,
    linkId: rollback.linkId,
  });
}

export async function completeOutgoingMeshPairingRequest(input: {
  requestId: string;
  localUserId: string;
  localNodeId: string;
  localNodeEndpoint: string | null;
  localNodeTransport: MeshTransport;
  remoteNodeId: string;
  remoteInstanceName?: string | null;
  remoteLocalUserId: string;
  remoteEndpoint: string;
  remoteTransport: MeshTransport;
  remotePublicKey: string;
  remoteFingerprint: string;
  remoteEncryptionPublicKey?: string;
  activeNodeId: string | null;
  takeoverGeneration: number;
  linkId: string;
}): Promise<MeshLinkRecord> {
  const db = getDatabase();
  const now = new Date().toISOString();
  let resolvedLinkId: string | undefined;
  const transaction = db.transaction(() => {
    const requestRow = db.query(`
      SELECT id, direction, link_id, target_link_id, target_local_user_id, requested_node_id,
        requested_local_user_id, requested_username, endpoint, transport,
        public_key, fingerprint, encryption_public_key, nonce, signature, status, expires_at,
        approved_at, approved_by_user_id, rejection_reason, created_at, updated_at
      FROM mesh_pairing_requests
      WHERE id = ?
    `).get(input.requestId) as MeshPairingRequestRow | null;
    const request = requestRow ? pairingRequestFromRow(requestRow) : null;
    const existingLinkRow = db.query(`
      SELECT link_id, local_user_id, active_node_id, takeover_generation,
        active_claimed_at, active_claim_origin, status, created_at, updated_at
      FROM mesh_links
      WHERE link_id = ?
    `).get(input.linkId) as MeshLinkRow | null;
    let decision: ReturnType<typeof decideCompleteOutgoingMeshPairing>;
    try {
      decision = decideCompleteOutgoingMeshPairing({
        request,
        localUserId: input.localUserId,
        localNodeId: input.localNodeId,
        remoteNodeId: input.remoteNodeId,
        link: existingLinkRow ? linkFromRow(existingLinkRow) : null,
        nowMs: Date.now(),
        linkId: input.linkId,
      });
    } catch (error) {
      markExpiredPairingRequestAndRethrow(db, input.requestId, now, error);
    }
    if (decision.kind === "idempotent") {
      resolvedLinkId = decision.linkId;
      return;
    }

    db.run(`
      INSERT INTO mesh_nodes (
          node_id, instance_name, public_key, fingerprint, encryption_public_key, endpoint, transport, status,
        last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
          instance_name = COALESCE(excluded.instance_name, mesh_nodes.instance_name),
          public_key = excluded.public_key,
        fingerprint = excluded.fingerprint,
        endpoint = excluded.endpoint,
        encryption_public_key = COALESCE(excluded.encryption_public_key, mesh_nodes.encryption_public_key),
        transport = excluded.transport,
        status = CASE
          WHEN mesh_nodes.status = 'revoked' THEN 'revoked'
          ELSE 'active'
        END,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `, [
      input.remoteNodeId,
      input.remoteInstanceName ?? null,
      input.remotePublicKey,
      input.remoteFingerprint,
      input.remoteEncryptionPublicKey ?? null,
      input.remoteEndpoint,
      input.remoteTransport,
      now,
      now,
      now,
    ]);

    if (decision.createLink) {
      db.run(`
        INSERT INTO mesh_links (
          link_id, local_user_id, active_node_id, takeover_generation,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?)
      `, [
        input.linkId,
        input.localUserId,
        input.activeNodeId ?? input.remoteNodeId,
        input.takeoverGeneration,
        now,
        now,
      ]);
      db.run(`
        INSERT INTO mesh_link_members (
          link_id, node_id, local_user_id, endpoint, transport, status,
          membership_generation, last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)
      `, [
        input.linkId,
        input.localNodeId,
        input.localUserId,
        input.localNodeEndpoint,
        input.localNodeTransport,
        now,
        now,
        now,
      ]);
    }
    db.run(`
      INSERT INTO mesh_link_members (
        link_id, node_id, local_user_id, endpoint, transport, status,
        membership_generation, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)
      ON CONFLICT(link_id, node_id) DO UPDATE SET
        local_user_id = excluded.local_user_id,
        endpoint = excluded.endpoint,
        transport = excluded.transport,
        status = 'active',
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `, [
      input.linkId,
      input.remoteNodeId,
      input.remoteLocalUserId,
      input.remoteEndpoint,
      input.remoteTransport,
      now,
      now,
      now,
    ]);
    db.run(`
      UPDATE mesh_pairing_requests
      SET link_id = ?, status = 'approved', approved_at = ?, updated_at = ?
      WHERE id = ?
    `, [input.linkId, now, now, input.requestId]);
    resolvedLinkId = input.linkId;
  });
  transaction();
  if (!resolvedLinkId) {
    throw new Error(`Outgoing mesh pairing request did not resolve to a link: ${input.requestId}`);
  }
  const link = await getMeshLinkForUser(resolvedLinkId, input.localUserId);
  if (!link) {
    throw new Error(`Mesh link was not persisted after pairing completion: ${resolvedLinkId}`);
  }
  log.info("Completed outgoing mesh pairing request", {
    requestId: input.requestId,
    linkId: resolvedLinkId,
  });
  return link;
}

export async function rejectMeshPairingRequest(
  requestId: string,
  rejectingUserId: string,
  reason: string | null,
): Promise<MeshPairingRequestRecord> {
  const db = getDatabase();
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    const requestRow = db.query(`
      SELECT id, direction, link_id, target_link_id, target_local_user_id, requested_node_id,
        requested_local_user_id, requested_username, endpoint, transport,
        public_key, fingerprint, encryption_public_key, nonce, signature, status, expires_at,
        approved_at, approved_by_user_id, rejection_reason, created_at, updated_at
      FROM mesh_pairing_requests
      WHERE id = ?
    `).get(requestId) as MeshPairingRequestRow | null;
    const request = requestRow ? pairingRequestFromRow(requestRow) : null;
    const ownedLinkRow = request?.linkId
      ? db.query(`
        SELECT link_id, local_user_id, active_node_id, takeover_generation,
          active_claimed_at, active_claim_origin, status, created_at, updated_at
        FROM mesh_links
        WHERE link_id = ? AND local_user_id = ?
      `).get(request.linkId, rejectingUserId) as MeshLinkRow | null
      : null;
    decideRejectMeshPairing({
      request,
      rejectingUserId,
      ownedLink: ownedLinkRow ? linkFromRow(ownedLinkRow) : null,
    });
    db.run(`
      UPDATE mesh_pairing_requests
      SET status = 'rejected', rejection_reason = ?, approved_by_user_id = ?,
        updated_at = ?
      WHERE id = ? AND status = 'pending'
    `, [reason, rejectingUserId, now, requestId]);
  });
  transaction();
  const updated = await getMeshPairingRequest(requestId);
  if (!updated) {
    throw new Error(`Mesh pairing request disappeared after rejection: ${requestId}`);
  }
  return updated;
}
