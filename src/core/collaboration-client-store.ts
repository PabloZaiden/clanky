/**
 * The shared client's encrypted, explicitly user-scoped Bun persistence adapter.
 */

import type { CreateCollaborationConnection } from "@/contracts/schemas/collaboration";
import type { CollaborationGuestGrant } from "@/shared/collaboration";
import {
  assertCollaborationPairingRevision, collaborationPairingRevision,
} from "../client-sdk/collaboration/pairing-state";
import type {
  CollaborationPairingSnapshot, CollaborationPairingStore,
} from "../client-sdk/collaboration/store";
import type { CollaborationSigningIdentity } from "../client-sdk/collaboration/types";
import { runWithCurrentUser } from "../context/user-context";
import { DomainError } from "../domain/domain-error";
import { getCollaborationOwnerUser } from "../persistence/collaboration-storage";
import { collaborationService } from "./collaboration-service";

export class BunCollaborationPairingStore implements CollaborationPairingStore {
  constructor(readonly scope: string) {}

  private withUser<T>(operation: () => T): T {
    const user = getCollaborationOwnerUser(this.scope);
    if (!user) throw new DomainError("collaboration_user_unavailable", "The local user is unavailable.");
    return runWithCurrentUser(user, operation);
  }

  async list() {
    return this.withUser(() => collaborationService.listConnections());
  }

  async get(connectionId: string): Promise<CollaborationPairingSnapshot> {
    return this.withUser(() => {
      const connection = collaborationService.listConnections().find((candidate) => candidate.id === connectionId);
      if (!connection) throw new DomainError("collaboration_connection_not_found", "Connection not found.");
      return { connection, revision: collaborationPairingRevision(connection) };
    });
  }

  async createPending(input: CreateCollaborationConnection): Promise<CollaborationPairingSnapshot> {
    const connection = await this.withUser(() => collaborationService.createPendingConnection(input));
    return { connection, revision: collaborationPairingRevision(connection) };
  }

  async loadIdentity(snapshot: CollaborationPairingSnapshot): Promise<CollaborationSigningIdentity> {
    const identity = await collaborationService.loadConnectionIdentityInternal(snapshot.connection.id, this.scope);
    const current = await this.get(snapshot.connection.id);
    assertCollaborationPairingRevision(identity.connection, snapshot.revision);
    assertCollaborationPairingRevision(current.connection, snapshot.revision);
    return {
      ...identity.connection.identity,
      sign: async (payload: string) => identity.sign(payload),
    };
  }

  async activate(snapshot: CollaborationPairingSnapshot, grant: CollaborationGuestGrant): Promise<CollaborationPairingSnapshot> {
    const connection = this.withUser(() => collaborationService.activateConnection(
      snapshot.connection.id, grant.id, snapshot.revision,
    ));
    return { connection, revision: collaborationPairingRevision(connection) };
  }

  async revoke(snapshot: CollaborationPairingSnapshot): Promise<void> {
    this.withUser(() => collaborationService.revokeConnection(snapshot.connection.id, snapshot.revision));
  }

  async forget(snapshot: CollaborationPairingSnapshot): Promise<void> {
    this.withUser(() => collaborationService.deleteConnection(snapshot.connection.id, snapshot.revision));
  }
}
