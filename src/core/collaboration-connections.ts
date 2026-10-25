/**
 * Local pairing lifecycle; the accepting user owns only credentials and trust.
 */

import type {
  CollaborationConnection,
  CollaborationConnectionChange,
} from "@/shared/collaboration";
import {
  type CreateCollaborationConnection,
} from "@/contracts/schemas/collaboration";
import { createPendingCollaborationPairing } from "../client-sdk/collaboration/pairing-state";
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
  validateCollaborationIdentity,
} from "./collaboration-identity";
import { CollaborationSubscriptions } from "./collaboration-subscriptions";

export interface CollaborationConnectionIdentity {
  connection: CollaborationConnection;
  sign(payload: string): string;
}

export class CollaborationConnections {
  private readonly changes = new CollaborationSubscriptions<CollaborationConnectionChange>();

  async createPendingConnection(input: CreateCollaborationConnection): Promise<CollaborationConnection> {
    const localUserId = requireCollaborationLocalUserId();
    const generated = generateCollaborationIdentity();
    const connection = await createPendingCollaborationPairing(input, generated.identity);
    const encrypted = await encryptPersistedSecret(generated.privateKey);
    insertCollaborationConnection(localUserId, connection, encrypted);
    return connection;
  }

  activateConnection(connectionId: string, guestId: string, expectedRevision: string): CollaborationConnection {
    const localUserId = requireCollaborationLocalUserId();
    const active = activateCollaborationConnection(localUserId, connectionId, guestId, expectedRevision);
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

  revokeConnection(connectionId: string, expectedRevision: string): void {
    const localUserId = requireCollaborationLocalUserId();
    revokeCollaborationConnection(localUserId, connectionId, expectedRevision);
    this.changes.publish({ localUserId, connectionId, status: "revoked" });
  }

  deleteConnection(connectionId: string, expectedRevision: string): void {
    const localUserId = requireCollaborationLocalUserId();
    deleteCollaborationConnection(localUserId, connectionId, expectedRevision);
    this.changes.publish({ localUserId, connectionId, status: "deleted" });
  }

  onConnectionChanged(listener: (event: CollaborationConnectionChange) => void): () => void {
    return this.changes.subscribe(listener);
  }
}
