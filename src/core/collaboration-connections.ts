/**
 * Local pairing lifecycle; the accepting user owns only credentials and trust.
 */

import { randomUUID } from "node:crypto";
import type {
  CollaborationConnection,
  CollaborationConnectionChange,
  CollaborationGuestGrant,
} from "@/shared/collaboration";
import { COLLABORATION_PROTOCOL_VERSION } from "@/shared/collaboration";
import {
  CollaborationGuestGrantSchema,
  CreateCollaborationConnectionSchema,
  type CreateCollaborationConnection,
} from "@/contracts/schemas/collaboration";
import { DomainError } from "../domain/domain-error";
import { decryptPersistedSecret, encryptPersistedSecret } from "../persistence/encrypted-secret";
import {
  activateCollaborationConnection,
  deleteCollaborationConnection,
  getCollaborationConnectionCiphertextInternal,
  insertCollaborationConnection,
  listActiveCollaborationConnectionsInternal,
  listCollaborationConnections,
  requireCollaborationConnection,
  revokeCollaborationConnection,
} from "../persistence/collaboration-connections";
import { requireCollaborationLocalUserId } from "./collaboration-authority";
import {
  createCollaborationSigner,
  generateCollaborationIdentity,
  parseCollaborationInput,
  validateCollaborationIdentity,
} from "./collaboration-identity";
import { CollaborationSubscriptions } from "./collaboration-subscriptions";

export interface CollaborationConnectionIdentity {
  connection: CollaborationConnection;
  sign(payload: string): string;
}

export class CollaborationConnections {
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly changes = new CollaborationSubscriptions<CollaborationConnectionChange>();

  async createPendingConnection(input: CreateCollaborationConnection): Promise<CollaborationConnection> {
    const localUserId = requireCollaborationLocalUserId();
    const parsed = parseCollaborationInput(CreateCollaborationConnectionSchema, input);
    const controller = validateCollaborationIdentity(parsed.controller);
    const previous = this.mutationTail;
    let release: () => void = () => {};
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const generated = generateCollaborationIdentity();
      const now = new Date();
      const connection: CollaborationConnection = {
        id: randomUUID(), name: parsed.name ?? null, controller,
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        relayUrl: parsed.relayUrl, relayFingerprint: parsed.relayFingerprint,
        identity: generated.identity, guestId: null, status: "pending",
        createdAt: now.toISOString(),
        pendingExpiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
      };
      const encrypted = await encryptPersistedSecret(generated.privateKey);
      insertCollaborationConnection(localUserId, connection, encrypted);
      return connection;
    } finally {
      release();
    }
  }

  activateConnection(connectionId: string, input: CollaborationGuestGrant): CollaborationConnection {
    const localUserId = requireCollaborationLocalUserId();
    const connection = requireCollaborationConnection(localUserId, connectionId);
    const grant = parseCollaborationInput(CollaborationGuestGrantSchema, input);
    validateCollaborationIdentity(grant.identity);
    if (grant.revokedAt !== null || grant.workspaceIds.length === 0
      || grant.identity.nodeId !== connection.identity.nodeId
      || grant.identity.publicKey !== connection.identity.publicKey
      || grant.identity.fingerprint !== connection.identity.fingerprint
      || grant.relayUrl !== connection.relayUrl || grant.relayFingerprint !== connection.relayFingerprint) {
      throw new DomainError("collaboration_grant_mismatch", "The guest grant does not match this connection.");
    }
    const active = activateCollaborationConnection(localUserId, connectionId, grant.id, new Date().toISOString());
    this.changes.publish({ localUserId, connectionId, status: "active" });
    return active;
  }

  listConnections(): CollaborationConnection[] {
    return listCollaborationConnections(requireCollaborationLocalUserId());
  }

  listActiveConnectionsInternal(): { localUserId: string; connection: CollaborationConnection }[] {
    return listActiveCollaborationConnectionsInternal();
  }

  async loadConnectionIdentity(connectionId: string): Promise<CollaborationConnectionIdentity> {
    return await this.loadConnectionIdentityInternal(connectionId, requireCollaborationLocalUserId());
  }

  async loadConnectionIdentityInternal(
    connectionId: string,
    localUserId: string,
  ): Promise<CollaborationConnectionIdentity> {
    const connection = requireCollaborationConnection(localUserId, connectionId);
    validateCollaborationIdentity(connection.controller);
    const ciphertext = getCollaborationConnectionCiphertextInternal(localUserId, connectionId, new Date().toISOString());
    let privateKey: string;
    try {
      privateKey = await decryptPersistedSecret(ciphertext);
    } catch (error) {
      throw new DomainError("collaboration_identity_unavailable", "The pairing key could not be decrypted.", { cause: error });
    }
    const signer = createCollaborationSigner(connection.identity, privateKey);
    return {
      connection,
      sign(payload: string): string {
        getCollaborationConnectionCiphertextInternal(localUserId, connectionId, new Date().toISOString());
        return signer(payload);
      },
    };
  }

  revokeConnection(connectionId: string): void {
    const localUserId = requireCollaborationLocalUserId();
    revokeCollaborationConnection(localUserId, connectionId);
    this.changes.publish({ localUserId, connectionId, status: "revoked" });
  }

  deleteConnection(connectionId: string): void {
    const localUserId = requireCollaborationLocalUserId();
    deleteCollaborationConnection(localUserId, connectionId);
    this.changes.publish({ localUserId, connectionId, status: "deleted" });
  }

  onConnectionChanged(listener: (event: CollaborationConnectionChange) => void): () => void {
    return this.changes.subscribe(listener);
  }
}
