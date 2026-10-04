import { describe, expect, test } from "bun:test";
import {
  MeshExecutionSessionRequestSchema,
  MeshExecutionRpcRequestSchema,
  type MeshExecutionSessionRequest,
} from "../../src/contracts/schemas/mesh-execution";
import { buildMeshExecutionSessionSigningPayload } from "../../src/core/mesh-protocol";
import {
  MESH_ACP_CHANNEL,
  MESH_EXECUTION_PROTOCOL_VERSION,
} from "../../src/shared/mesh-execution";
import { MESH_PROTOCOL_VERSION, type MeshProtocolVersion } from "../../src/shared/mesh-protocol";
import { MeshHarnessEventSchema } from "../../src/contracts/schemas/mesh-harness";

function buildRequest(
  encryptedEnvironment?: unknown,
  protocolVersion: MeshProtocolVersion = MESH_PROTOCOL_VERSION,
): Omit<MeshExecutionSessionRequest, "signature"> {
  const request: Omit<MeshExecutionSessionRequest, "signature"> = {
    protocolVersion,
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
  // A pure protocol test protects the bounded child control identity before
  // encrypted native events become owned persisted interaction scopes.
  test("native Mesh child scopes require activity IDs of 1-500 characters", () => {
    const event = { type: "question.resolved", requestId: "request-1", outcome: "cancelled" };
    const valid = (activityId: string) => MeshHarnessEventSchema.safeParse({
      ...event, scope: { kind: "child", activityId },
    }).success;
    expect(valid("a")).toBe(true);
    expect(valid("a".repeat(500))).toBe(true);
    expect(valid("")).toBe(false);
    expect(valid("a".repeat(501))).toBe(false);
  });

  test("signs the canonical v5 request shape", () => {
    const request = buildRequest(undefined, 5);
    const payload = JSON.stringify([
      "clanky-mesh-execution-session-v5",
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
