/**
 * Core entry points for mesh authority transitions.
 *
 * The persistence adapters retain transaction ownership while this module
 * keeps callers from bypassing the shared Core transition surface.
 */

import type { MeshTakeoverRecord } from "@/shared/mesh";
import {
  applyMeshLinkTakeover,
  claimMeshLinkForLocalUser,
} from "../persistence/mesh";

export interface ClaimMeshTakeoverInput {
  linkId: string;
  localUserId: string;
  nodeId: string;
  claimOrigin: string;
  expectedGeneration?: number;
}

export async function claimMeshTakeover(
  input: ClaimMeshTakeoverInput,
): Promise<MeshTakeoverRecord> {
  return await claimMeshLinkForLocalUser(input);
}

export interface ApplyMeshTakeoverInput {
  linkId: string;
  nodeId: string;
  generation: number;
  claimedAt: string;
  claimOrigin: string;
  signature: string;
}

export async function applyMeshTakeover(
  input: ApplyMeshTakeoverInput,
): Promise<MeshTakeoverRecord> {
  return await applyMeshLinkTakeover(input);
}
