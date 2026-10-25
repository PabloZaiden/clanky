/**
 * Common pairing validation and compare-and-commit state tokens.
 */

import {
  CollaborationGuestGrantSchema, CreateCollaborationConnectionSchema,
  type CreateCollaborationConnection,
} from "@/contracts/schemas/collaboration";
import type { CollaborationConnection, CollaborationGuestGrant } from "@/shared/collaboration";
import { COLLABORATION_PROTOCOL_VERSION } from "@/shared/collaboration";
import type { MeshRelayPeerIdentity } from "@/shared/mesh-relay";
import { DomainError } from "../../domain/domain-error";
import { getClientKeyFingerprint } from "./crypto";

export async function createPendingCollaborationPairing(
  input: CreateCollaborationConnection,
  identity: MeshRelayPeerIdentity,
): Promise<CollaborationConnection> {
  const parsed = CreateCollaborationConnectionSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError("collaboration_input_invalid", "The collaboration request is invalid.", { cause: parsed.error });
  }
  const value = parsed.data;
  try {
    if (await getClientKeyFingerprint(value.controller.publicKey) !== value.controller.fingerprint
      || await getClientKeyFingerprint(identity.publicKey) !== identity.fingerprint) {
      throw new Error("The public key does not match its fingerprint.");
    }
  } catch (error) {
    throw new DomainError("collaboration_identity_invalid", "The pairing identity is invalid.", { cause: error });
  }
  const now = new Date();
  return {
    id: crypto.randomUUID(), name: value.name ?? null, controller: value.controller,
    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    relayUrl: value.relayUrl, relayFingerprint: value.relayFingerprint,
    identity, guestId: null, status: "pending", createdAt: now.toISOString(),
    pendingExpiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
  };
}

export function collaborationPairingRevision(connection: CollaborationConnection): string {
  // Pairings have immutable identities and only forward status transitions, so
  // their canonical public state is an ABA-safe CAS token without a schema change.
  return JSON.stringify([
    connection.id, connection.protocolVersion, connection.name,
    connection.controller.nodeId, connection.controller.publicKey, connection.controller.fingerprint,
    connection.relayUrl, connection.relayFingerprint,
    connection.identity.nodeId, connection.identity.publicKey, connection.identity.fingerprint,
    connection.status, connection.guestId, connection.createdAt, connection.pendingExpiresAt,
  ]);
}

export function assertCollaborationPairingRevision(connection: CollaborationConnection, revision: string): void {
  if (collaborationPairingRevision(connection) !== revision) {
    throw new DomainError("collaboration_connection_stale", "The pairing changed while the operation was in progress.");
  }
}

export function assertCollaborationPairingUsable(connection: CollaborationConnection): void {
  if (connection.status === "revoked"
    || connection.status === "pending" && Date.parse(connection.pendingExpiresAt) <= Date.now()) {
    throw new DomainError("collaboration_connection_inactive", "The connection identity is no longer available.");
  }
}

export function activateCollaborationPairing(
  connection: CollaborationConnection,
  guestId: string,
  expectedRevision: string,
): CollaborationConnection {
  assertCollaborationPairingRevision(connection, expectedRevision);
  assertCollaborationPairingUsable(connection);
  if (connection.guestId !== null && connection.guestId !== guestId) {
    throw new DomainError("collaboration_connection_inactive", "The connection can no longer be activated.");
  }
  return { ...connection, status: "active", guestId };
}

export async function validateCollaborationPairingGrant(
  connection: CollaborationConnection,
  input: unknown,
): Promise<CollaborationGuestGrant> {
  const parsed = CollaborationGuestGrantSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError("collaboration_response_invalid", "The controller returned an invalid pairing grant.", {
      cause: parsed.error,
    });
  }
  const grant = parsed.data;
  if (grant.revokedAt !== null || grant.workspaceIds.length === 0
    || grant.identity.nodeId !== connection.identity.nodeId
    || grant.identity.publicKey !== connection.identity.publicKey
    || grant.identity.fingerprint !== connection.identity.fingerprint
    || grant.relayUrl !== connection.relayUrl || grant.relayFingerprint !== connection.relayFingerprint
    || await getClientKeyFingerprint(grant.identity.publicKey) !== grant.identity.fingerprint) {
    throw new DomainError("collaboration_grant_mismatch", "The guest grant does not match this connection.");
  }
  assertCollaborationPairingUsable(connection);
  return grant;
}
