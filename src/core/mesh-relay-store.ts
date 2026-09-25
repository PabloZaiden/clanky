/**
 * Process-local relay trust state rebuilt by the controller after connection.
 */

import type { MeshRelayPeerIdentity } from "@/shared/mesh-relay";

export interface RelayControllerPairing extends MeshRelayPeerIdentity {
  pairedAt: string;
  updatedAt: string;
}

function copyIdentity(identity: MeshRelayPeerIdentity): MeshRelayPeerIdentity {
  return {
    nodeId: identity.nodeId,
    publicKey: identity.publicKey,
    fingerprint: identity.fingerprint,
  };
}

function compareNodeIds(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

export class MeshRelayStore {
  private controller: RelayControllerPairing | undefined;
  private authorizedWorkers = new Map<string, MeshRelayPeerIdentity>();

  getController(): RelayControllerPairing | undefined {
    return this.controller ? { ...this.controller } : undefined;
  }

  pairController(identity: MeshRelayPeerIdentity): RelayControllerPairing {
    const existing = this.controller;
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
    const pairing: RelayControllerPairing = {
      ...copyIdentity(identity),
      pairedAt: existing?.pairedAt ?? now,
      updatedAt: now,
    };
    this.controller = pairing;
    return { ...pairing };
  }

  getAuthorizedWorker(nodeId: string): MeshRelayPeerIdentity | undefined {
    const worker = this.authorizedWorkers.get(nodeId);
    return worker ? copyIdentity(worker) : undefined;
  }

  listAuthorizedWorkers(): MeshRelayPeerIdentity[] {
    return [...this.authorizedWorkers.values()]
      .sort((left, right) => compareNodeIds(left.nodeId, right.nodeId))
      .map(copyIdentity);
  }

  replaceAuthorizedWorkers(workers: readonly MeshRelayPeerIdentity[]): void {
    const nextWorkers = new Map<string, MeshRelayPeerIdentity>();
    const fingerprints = new Set<string>();
    for (const worker of workers) {
      if (
        nextWorkers.has(worker.nodeId)
        || fingerprints.has(worker.fingerprint)
      ) {
        throw new Error("Relay authorization contains duplicate worker identities.");
      }
      nextWorkers.set(worker.nodeId, copyIdentity(worker));
      fingerprints.add(worker.fingerprint);
    }
    this.authorizedWorkers = nextWorkers;
  }
}
