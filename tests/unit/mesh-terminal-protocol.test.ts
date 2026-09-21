import { describe, expect, test } from "bun:test";
import {
  MeshTerminalClientFrameSchema,
  MeshTerminalSessionRequestSchema,
  type MeshTerminalSessionRequest,
} from "../../src/contracts/schemas/mesh-terminal";
import { buildMeshTerminalSessionSigningPayload } from "../../src/core/mesh-terminal-protocol";
import { splitUtf8 } from "../../src/core/mesh-terminal-gateway";
import {
  MESH_TERMINAL_CAPABILITY,
  MESH_TERMINAL_MAX_INPUT_BYTES,
  MESH_TERMINAL_PROTOCOL_VERSION,
} from "../../src/shared/mesh-terminal";
import { MESH_PROTOCOL_VERSION } from "../../src/shared/mesh-protocol";

function buildRequest(
  protocolVersion:
    | typeof MESH_TERMINAL_PROTOCOL_VERSION
    | typeof MESH_PROTOCOL_VERSION = MESH_TERMINAL_PROTOCOL_VERSION,
): Omit<MeshTerminalSessionRequest, "signature"> {
  return {
    protocolVersion,
    capability: MESH_TERMINAL_CAPABILITY,
    requestId: "request-1",
    callerNodeId: "caller-1",
    callerPublicKey: "public-key",
    callerFingerprint: "fingerprint",
    callerEncryptionPublicKey: "encryption-key",
    targetNodeId: "target-1",
    workspaceId: "workspace-1",
    executionRoot: "/workspaces/repo",
    directory: "/workspaces/repo/.clanky-worktrees/task-1",
    provider: "copilot",
    terminalSessionId: "terminal-1",
    remoteSessionName: "clanky-terminal-1",
    connectionMode: "dtach",
    useTmux: false,
    allowPersistentSessionCreate: true,
    encryptedEnvironment: { ciphertext: "encrypted" },
    nonce: "nonce-1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe("Mesh terminal protocol", () => {
  test("binds execution paths and terminal runtime settings into the signature", () => {
    const request = buildRequest();
    const payload = buildMeshTerminalSessionSigningPayload(request);

    expect(buildMeshTerminalSessionSigningPayload({
      ...request,
      directory: "/workspaces/repo",
    })).not.toBe(payload);
    expect(buildMeshTerminalSessionSigningPayload({
      ...request,
      connectionMode: "direct",
    })).not.toBe(payload);
  });

  test("uses the v5 signing domain and canonical payload order", () => {
    const request = buildRequest(MESH_PROTOCOL_VERSION);
    const payload = JSON.stringify([
      "clanky-mesh-terminal-session-v5",
      request.protocolVersion,
      request.capability,
      request.requestId,
      request.callerNodeId,
      request.callerPublicKey,
      request.callerFingerprint,
      request.callerEncryptionPublicKey,
      request.targetNodeId,
      request.workspaceId,
      request.executionRoot,
      request.directory,
      request.provider,
      request.terminalSessionId,
      request.remoteSessionName,
      request.connectionMode,
      request.useTmux,
      request.allowPersistentSessionCreate,
      request.encryptedEnvironment,
      request.nonce,
      request.expiresAt,
    ]);

    expect(MeshTerminalSessionRequestSchema.safeParse({
      ...request,
      signature: "signature",
    }).success).toBe(true);
    expect(buildMeshTerminalSessionSigningPayload(request)).toBe(payload);
  });

  test("requires the terminal-v1 capability", () => {
    const request = buildRequest();
    expect(MeshTerminalSessionRequestSchema.safeParse({
      ...request,
      signature: "signature",
    }).success).toBe(true);
    expect(MeshTerminalSessionRequestSchema.safeParse({
      ...request,
      capability: "terminal-v2",
      signature: "signature",
    }).success).toBe(false);
  });

  test("bounds terminal input by UTF-8 byte size", () => {
    expect(MeshTerminalClientFrameSchema.safeParse({
      type: "terminal.input",
      data: "a".repeat(MESH_TERMINAL_MAX_INPUT_BYTES),
    }).success).toBe(true);
    expect(MeshTerminalClientFrameSchema.safeParse({
      type: "terminal.input",
      data: "é".repeat((MESH_TERMINAL_MAX_INPUT_BYTES / 2) + 1),
    }).success).toBe(false);
  });

  test("splits terminal output without breaking Unicode code points", () => {
    const value = "a😀b😀c";
    const chunks = splitUtf8(value, 5);

    expect(chunks.join("")).toBe(value);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 5)).toBe(true);
    expect(chunks).toEqual(["a😀", "b😀", "c"]);
  });
});
