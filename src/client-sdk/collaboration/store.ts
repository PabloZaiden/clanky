/**
 * Scoped pairing persistence and host-owned exclusive connection leases.
 */

import type { CreateCollaborationConnection } from "@/contracts/schemas/collaboration";
import type { CollaborationConnection, CollaborationGuestGrant } from "@/shared/collaboration";
import type { CollaborationSigningIdentity } from "./types";

export interface CollaborationPairingSnapshot {
  connection: CollaborationConnection;
  revision: string;
}

export interface CollaborationPairingStore {
  readonly scope: string;
  list(): Promise<CollaborationConnection[]>;
  get(connectionId: string): Promise<CollaborationPairingSnapshot>;
  createPending(input: CreateCollaborationConnection): Promise<CollaborationPairingSnapshot>;
  loadIdentity(snapshot: CollaborationPairingSnapshot): Promise<CollaborationSigningIdentity>;
  activate(snapshot: CollaborationPairingSnapshot, grant: CollaborationGuestGrant): Promise<CollaborationPairingSnapshot>;
  revoke(snapshot: CollaborationPairingSnapshot): Promise<void>;
  forget(snapshot: CollaborationPairingSnapshot): Promise<void>;
}

export interface CollaborationConnectionLease {
  release(): Promise<void>;
}

export interface CollaborationConnectionOwnership {
  acquire(kind: "destination" | "connection", key: string): Promise<CollaborationConnectionLease>;
}
