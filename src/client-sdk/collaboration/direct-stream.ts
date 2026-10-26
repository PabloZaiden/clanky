import {
  WORKSPACE_DIRECT_PATH, WorkspaceDirectReadySchema, workspaceDirectReadyPayload,
} from "@/contracts/schemas/mesh-client";
import type { MeshRelayPeerIdentity } from "@/shared/mesh-relay";
import { MESH_PROTOCOL_VERSION } from "@/shared/mesh-protocol";
import { DomainError } from "../../domain/domain-error";
import { openMeshDataStream } from "../../core/mesh-relay-data-stream";
import { normalizeMeshEnrollmentTarget } from "../../core/mesh-target-discovery";
import { getClientKeyFingerprint, verifyClientSignature } from "./crypto";
import { readWorkspaceClientProof } from "./proof";
import type { CollaborationClientLogger } from "./types";

export async function openWorkspaceDirectStream(input: {
  controllerUrl: string;
  controller: MeshRelayPeerIdentity;
  identity: MeshRelayPeerIdentity;
  kind: "http" | "socket" | "probe";
  headers: Record<string, string>;
  signal?: AbortSignal;
  logger?: CollaborationClientLogger;
}) {
  const url = new URL(WORKSPACE_DIRECT_PATH, normalizeMeshEnrollmentTarget(input.controllerUrl));
  url.protocol = "wss:";
  const proof = readWorkspaceClientProof(new Headers(input.headers));
  const streamId = crypto.randomUUID();
  return await openMeshDataStream({
    url: url.toString(), requestId: proof.requestId, streamId,
    openingFrame: JSON.stringify({
      type: "workspace.open", protocolVersion: MESH_PROTOCOL_VERSION,
      requestId: proof.requestId, streamId, kind: input.kind,
      identity: {
        nodeId: input.identity.nodeId, publicKey: input.identity.publicKey,
        fingerprint: input.identity.fingerprint,
      },
      headers: input.headers,
    }),
    signal: input.signal, logger: input.logger,
    verifyReady: async (raw) => {
      const ready = WorkspaceDirectReadySchema.parse(raw);
      if (await getClientKeyFingerprint(input.controller.publicKey) !== input.controller.fingerprint
        || !await verifyClientSignature(workspaceDirectReadyPayload(ready), ready.signature, input.controller.publicKey)) {
        throw new DomainError("collaboration_controller_mismatch", "The direct controller identity does not match the invitation.");
      }
    },
  });
}
