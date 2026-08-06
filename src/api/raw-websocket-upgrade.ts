/**
 * Shared authorization and error handling for app-owned raw WebSocket routes.
 */

import { domainErrorResponse } from "./helpers";
import { assertLocalMeshActive } from "../core/mesh-activity";

export type RawWebSocketUpgrade = () => Response | undefined | Promise<Response | undefined>;

export function meshAuthorityErrorResponse(error: unknown): Response {
  return domainErrorResponse(error, {
    fallback: {
      error: "mesh_authority_check_failed",
      message: "Mesh authority could not be verified",
      status: 500,
    },
    mappings: {
      linked_node_not_active: {
        status: 409,
        message: "This Clanky instance is not the active mesh node",
      },
      mesh_link_conflict: {
        status: 409,
        message: "The linked mesh has an unresolved authority conflict",
      },
      mesh_link_revoked: {
        status: 403,
        message: "The linked mesh membership has been revoked",
      },
    },
  });
}

export async function authorizedRawWebSocketUpgrade(
  userId: string,
  upgrade: RawWebSocketUpgrade,
): Promise<Response | undefined> {
  try {
    await assertLocalMeshActive(userId);
    return await upgrade();
  } catch (error: unknown) {
    return meshAuthorityErrorResponse(error);
  }
}
