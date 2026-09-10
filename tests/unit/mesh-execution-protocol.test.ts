import { describe, expect, test } from "bun:test";
import {
  MeshExecutionSessionRequestSchema,
  type MeshExecutionSessionRequest,
} from "../../src/contracts/schemas/mesh-execution";
import { buildMeshExecutionSessionSigningPayload } from "../../src/core/mesh-protocol";
import { MESH_ACP_CHANNEL, MESH_EXECUTION_PROTOCOL_VERSION } from "../../src/shared/mesh-execution";

function buildRequest(
  encryptedEnvironment?: unknown,
): Omit<MeshExecutionSessionRequest, "signature"> {
  return {
    protocolVersion: MESH_EXECUTION_PROTOCOL_VERSION,
    requestId: "request-1",
    callerNodeId: "caller-1",
    callerPublicKey: "public-key",
    callerFingerprint: "fingerprint",
    callerEncryptionPublicKey: "encryption-key",
    targetNodeId: "target-1",
    workspaceId: "workspace-1",
    directory: "/workspaces/repo",
    provider: "copilot",
    channel: MESH_ACP_CHANNEL,
    ...(encryptedEnvironment === undefined ? {} : { encryptedEnvironment }),
    nonce: "nonce-1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe("Mesh execution session protocol", () => {
  test("keeps legacy signatures stable when no managed environment is present", () => {
    const request = buildRequest();
    const legacyPayload = JSON.stringify([
      "clanky-mesh-execution-session-v1",
      request.protocolVersion,
      request.requestId,
      request.callerNodeId,
      request.callerPublicKey,
      request.callerFingerprint,
      request.callerEncryptionPublicKey,
      request.targetNodeId,
      request.workspaceId,
      request.directory,
      request.provider,
      request.channel,
      request.nonce,
      request.expiresAt,
    ]);

    expect(buildMeshExecutionSessionSigningPayload(request)).toBe(legacyPayload);
  });

  test("binds the encrypted managed environment into the session signature", () => {
    const request = buildRequest({ ciphertext: "encrypted" });
    const payload = buildMeshExecutionSessionSigningPayload(request);

    expect(payload).toContain("\"encrypted\"");
    expect(buildMeshExecutionSessionSigningPayload({
      ...request,
      encryptedEnvironment: { ciphertext: "different" },
    })).not.toBe(payload);
  });

  test("accepts an encrypted environment field on ACP session requests", () => {
    expect(MeshExecutionSessionRequestSchema.safeParse({
      ...buildRequest({ ciphertext: "encrypted" }),
      signature: "signature",
    }).success).toBe(true);
  });
});
