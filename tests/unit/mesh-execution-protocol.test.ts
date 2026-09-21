import { describe, expect, test } from "bun:test";
import {
  MeshExecutionSessionRequestSchema,
  MeshExecutionRpcRequestSchema,
  type MeshExecutionSessionRequest,
} from "../../src/contracts/schemas/mesh-execution";
import { buildMeshExecutionSessionSigningPayload } from "../../src/core/mesh-protocol";
import { MESH_ACP_CHANNEL, MESH_EXECUTION_PROTOCOL_VERSION } from "../../src/shared/mesh-execution";

function buildRequest(
  encryptedEnvironment?: unknown,
): Omit<MeshExecutionSessionRequest, "signature"> {
  const request: Omit<MeshExecutionSessionRequest, "signature"> = {
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
    nonce: "nonce-1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  return encryptedEnvironment === undefined
    ? request
    : { ...request, encryptedEnvironment };
}

describe("Mesh execution session protocol", () => {
  test("signs the canonical request shape when no managed environment is present", () => {
    const request = buildRequest();
    const payload = JSON.stringify([
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

    expect(MeshExecutionSessionRequestSchema.safeParse({
      ...request,
      signature: "signature",
    }).success).toBe(true);
    expect(buildMeshExecutionSessionSigningPayload(request)).toBe(payload);
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

  test("validates the structured Git RPC boundary", () => {
    const request = {
      protocolVersion: MESH_EXECUTION_PROTOCOL_VERSION,
      sessionId: "session-1",
      sessionToken: "x".repeat(32),
      requestId: "request-1",
      operation: "git",
      cwd: "/workspaces/repo",
      args: ["status", "--short"],
      gitScope: "repository",
    } as const;

    expect(MeshExecutionRpcRequestSchema.safeParse(request).success).toBe(true);
    expect(MeshExecutionRpcRequestSchema.safeParse({
      ...request,
      gitScope: undefined,
    }).success).toBe(false);
    expect(MeshExecutionRpcRequestSchema.safeParse({
      ...request,
      env: { PATH: "/tmp" },
    }).success).toBe(false);
  });

  test("validates provider discovery as a command-free ACP operation", () => {
    const request = {
      protocolVersion: MESH_EXECUTION_PROTOCOL_VERSION,
      sessionId: "session-1",
      sessionToken: "x".repeat(32),
      requestId: "request-1",
      operation: "agentProviderAvailability",
      agentProvider: "copilot",
    } as const;

    expect(MeshExecutionRpcRequestSchema.safeParse(request).success).toBe(true);
    expect(MeshExecutionRpcRequestSchema.safeParse({
      ...request,
      agentProvider: undefined,
    }).success).toBe(false);
    expect(MeshExecutionRpcRequestSchema.safeParse({
      ...request,
      command: "sh",
      args: ["-lc", "command -v copilot"],
    }).success).toBe(false);
  });
});
