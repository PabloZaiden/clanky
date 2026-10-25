/**
 * Server-owned node identity and logging adapter for portable relay connections.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import { ensureLocalMeshNodeIdentity, signMeshPayload } from "../persistence/mesh-node-identity";
import { MeshRelayConnector, type MeshRelayConnectorIdentity, type MeshRelayConnectorOptions } from "./mesh-relay-connector";

const log = createLogger("core:mesh-relay-connector");

export type MeshNodeRelayConnectorOptions = Omit<MeshRelayConnectorOptions, "identity"> & {
  identity?: MeshRelayConnectorOptions["identity"];
};

export async function loadMeshNodeRelayIdentity(): Promise<MeshRelayConnectorIdentity> {
  const identity = await ensureLocalMeshNodeIdentity();
  return {
    nodeId: identity.nodeId,
    publicKey: identity.publicKey,
    fingerprint: identity.fingerprint,
    sign: signMeshPayload,
  };
}

export function createMeshNodeRelayConnector(options: MeshNodeRelayConnectorOptions): MeshRelayConnector {
  return new MeshRelayConnector({
    ...options,
    identity: options.identity ?? loadMeshNodeRelayIdentity,
    logger: options.logger ?? log,
  });
}
