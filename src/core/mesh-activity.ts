/**
 * Server-side authority checks for linked-instance mutations.
 *
 * Reads and background synchronization remain available on every member, but
 * only the node holding the current takeover claim may start new work or
 * mutate linked application state through the local API.
 */

import { ensureLocalMeshNodeIdentity } from "../persistence/mesh-node-identity";
import { getMeshLinkForLocalUser, listMeshLinkMembers } from "../persistence/mesh";
import { isMeshAggregateEligible } from "../persistence/mesh-sync";
import type { MeshSyncAggregateType } from "@/shared/mesh";
import { DomainError } from "./domain-error";

export async function assertLocalMeshActive(localUserId: string): Promise<void> {
  const identity = await ensureLocalMeshNodeIdentity();
  const link = await getMeshLinkForLocalUser(localUserId);
  if (!link) {
    return;
  }
  if (link.status === "conflict") {
    throw new DomainError(
      "mesh_link_conflict",
      "The linked mesh has an unresolved authority conflict.",
      { details: { linkId: link.linkId } },
    );
  }
  if (link.status === "revoked") {
    throw new DomainError("mesh_link_revoked", "The linked mesh membership has been revoked.");
  }
  const member = (await listMeshLinkMembers(link.linkId))
    .find((candidate) => candidate.nodeId === identity.nodeId);
  if (!member || member.status === "revoked") {
    throw new DomainError("mesh_link_revoked", "The local mesh node membership has been revoked.");
  }
  if (!link.activeNodeId || link.activeNodeId !== identity.nodeId) {
    throw new DomainError(
      "linked_node_not_active",
      "This Clanky instance is not the active node for the linked mesh.",
      {
        details: {
          linkId: link.linkId,
          activeNodeId: link.activeNodeId,
          localNodeId: identity.nodeId,
          takeoverGeneration: link.takeoverGeneration,
        },
      },
    );
  }
}

export async function assertLocalMeshActiveForAggregate(
  localUserId: string,
  aggregateType: MeshSyncAggregateType,
  aggregateId: string,
): Promise<void> {
  if (!isMeshAggregateEligible(localUserId, aggregateType, aggregateId)) {
    return;
  }
  await assertLocalMeshActive(localUserId);
}
