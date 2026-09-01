import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  MESH_ACP_SESSION_REQUEST_TTL_MS,
  MESH_ACP_SESSION_TTL_MS,
} from "../../src/shared/mesh-execution";
import { MeshCommandExecutorClient } from "../../src/core/mesh-command-executor-client";
import { encryptMeshPayload } from "../../src/core/mesh-payload-crypto";
import {
  createMeshLink,
  mergeMeshLinkMember,
} from "../../src/persistence/mesh";
import {
  ensureLocalMeshNodeIdentity,
  getMeshNodeFingerprint,
  setLocalMeshInstanceName,
} from "../../src/persistence/mesh-node-identity";
import { closeDatabase, getDatabase, initializeDatabase } from "../../src/persistence/database";

const createdDataDirs: string[] = [];
const originalDataDir = process.env["CLANKY_DATA_DIR"];
const originalPublicBaseUrl = process.env["CLANKY_PUBLIC_BASE_URL"];

async function setupClientMesh(): Promise<{
  localIdentity: Awaited<ReturnType<typeof ensureLocalMeshNodeIdentity>>;
  localUserId: string;
  remoteNodeId: string;
  linkId: string;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "clanky-mesh-client-"));
  createdDataDirs.push(dataDir);
  closeDatabase();
  process.env["CLANKY_DATA_DIR"] = dataDir;
  process.env["CLANKY_PUBLIC_BASE_URL"] = "http://127.0.0.1:4101";
  await initializeDatabase();

  const localUserId = "mesh-client-user";
  const now = new Date().toISOString();
  getDatabase().run(`
    INSERT INTO webapp_users (
      id, username, role, auth_version, created_at, updated_at,
      last_login_at, disabled_at
    ) VALUES (?, ?, 'user', 1, ?, ?, NULL, NULL)
  `, [localUserId, localUserId, now, now]);

  await setLocalMeshInstanceName("Local instance");
  const localIdentity = await ensureLocalMeshNodeIdentity();
  const link = await createMeshLink({
    localUserId,
    localNodeId: localIdentity.nodeId,
    localNodeEndpoint: "http://127.0.0.1:4101",
    localNodeTransport: "http",
  });

  const remoteNodeId = crypto.randomUUID();
  const remoteKeyPair = generateKeyPairSync("ed25519");
  const remotePublicKey = remoteKeyPair.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  await mergeMeshLinkMember({
    linkId: link.linkId,
    nodeId: remoteNodeId,
    instanceName: "Remote instance",
    localUserId,
    endpoint: "http://127.0.0.1:4102",
    transport: "http",
    status: "active",
    membershipGeneration: 1,
    publicKey: remotePublicKey,
    fingerprint: getMeshNodeFingerprint(remotePublicKey),
  });

  return {
    localIdentity,
    localUserId,
    remoteNodeId,
    linkId: link.linkId,
  };
}

afterEach(async () => {
  closeDatabase();
  if (originalDataDir === undefined) {
    delete process.env["CLANKY_DATA_DIR"];
  } else {
    process.env["CLANKY_DATA_DIR"] = originalDataDir;
  }
  if (originalPublicBaseUrl === undefined) {
    delete process.env["CLANKY_PUBLIC_BASE_URL"];
  } else {
    process.env["CLANKY_PUBLIC_BASE_URL"] = originalPublicBaseUrl;
  }
  while (createdDataDirs.length > 0) {
    const dataDir = createdDataDirs.pop();
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});

describe("mesh command executor client", () => {
  test("streams arbitrary host files and propagates cancellation", async () => {
    const {
      localIdentity,
      localUserId,
      remoteNodeId,
    } = await setupClientMesh();
    const encryptionPublicKey = localIdentity.encryptionPublicKey;
    if (!encryptionPublicKey) {
      throw new Error("The local Mesh identity has no encryption public key.");
    }

    let streamCancelled = false;
    const fetchImpl: typeof globalThis.fetch = Object.assign(
      async (
        url: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ): Promise<Response> => {
        if (init?.method === "GET") {
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode("mesh file payload"));
            },
            cancel() {
              streamCancelled = true;
            },
          });
          return new Response(stream, { status: 200 });
        }
        const parsedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(new URL(String(url)).pathname).toContain("/api/mesh/internal/execution/session");
        return Response.json({
          protocolVersion: 1,
          sessionId: "session-file-1",
          expiresAt: parsedBody["expiresAt"],
          encryptedPayload: encryptMeshPayload(
            { sessionToken: "s".repeat(32) },
            encryptionPublicKey,
          ),
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    const client = new MeshCommandExecutorClient({
      workspaceId: "workspace-1",
      directory: "/workspace/repo",
      executionNodeId: remoteNodeId,
      provider: "copilot",
      localUserId,
      fetch: fetchImpl,
    });

    const stream = await client.streamFile("/tmp/report.bin");
    expect(stream).toBeDefined();
    const reader = stream!.getReader();
    const firstChunk = await reader.read();
    expect(new TextDecoder().decode(firstChunk.value)).toBe("mesh file payload");
    await reader.cancel();
    expect(streamCancelled).toBe(true);
    client.closeSession();
  });

  test("streams binary writes and copies files through the execution peer", async () => {
    const {
      localIdentity,
      localUserId,
      remoteNodeId,
    } = await setupClientMesh();
    const encryptionPublicKey = localIdentity.encryptionPublicKey;
    if (!encryptionPublicKey) {
      throw new Error("The local Mesh identity has no encryption public key.");
    }

    const payload = new TextEncoder().encode("mesh upload payload");
    let uploadedPayload: Uint8Array | undefined;
    const rpcOperations: Record<string, unknown>[] = [];
    const fetchImpl: typeof globalThis.fetch = Object.assign(
      async (
        url: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ): Promise<Response> => {
        const requestUrl = new URL(String(url));
        if (requestUrl.pathname.endsWith("/session")) {
          const parsedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json({
            protocolVersion: 1,
            sessionId: "session-write-1",
            expiresAt: parsedBody["expiresAt"],
            encryptedPayload: encryptMeshPayload(
              { sessionToken: "s".repeat(32) },
              encryptionPublicKey,
            ),
          });
        }
        if (requestUrl.pathname.endsWith("/file") && init?.method === "POST") {
          uploadedPayload = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
          expect(requestUrl.searchParams.get("path")).toBe("/tmp/upload.bin");
          expect(requestUrl.searchParams.get("append")).toBe("1");
          expect(requestUrl.searchParams.get("expectedOffset")).toBe("4");
          expect(requestUrl.searchParams.get("maxBytes")).toBe(String(payload.byteLength));
          return Response.json({
            success: true,
            bytesWritten: payload.byteLength,
          });
        }
        if (requestUrl.pathname.endsWith("/rpc")) {
          const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
          rpcOperations.push(request);
          expect(request["operation"]).toBe("copyFile");
          expect(request["sourcePath"]).toBe("/tmp/source.bin");
          expect(request["destinationPath"]).toBe("/tmp/destination.bin");
          return Response.json({
            protocolVersion: 1,
            requestId: request["requestId"],
            encryptedPayload: encryptMeshPayload(true, encryptionPublicKey),
          });
        }
        throw new Error(`Unexpected Mesh request: ${requestUrl.pathname}`);
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    const client = new MeshCommandExecutorClient({
      workspaceId: "workspace-1",
      directory: "/workspace/repo",
      executionNodeId: remoteNodeId,
      provider: "copilot",
      localUserId,
      fetch: fetchImpl,
    });

    const writeResult = await client.writeFileStream(
      "/tmp/upload.bin",
      new Blob([payload]).stream(),
      {
        append: true,
        expectedOffset: 4,
        maxBytes: payload.byteLength,
      },
    );
    expect(writeResult).toEqual({
      success: true,
      bytesWritten: payload.byteLength,
    });
    expect(uploadedPayload).toEqual(payload);
    expect(await client.copyFile("/tmp/source.bin", "/tmp/destination.bin")).toBe(true);
    expect(rpcOperations).toHaveLength(1);
    client.closeSession();
  });

  test("requests ACP sessions below the gateway lifetime limit", async () => {
    const {
      localIdentity,
      localUserId,
      remoteNodeId,
    } = await setupClientMesh();
    const encryptionPublicKey = localIdentity.encryptionPublicKey;
    if (!encryptionPublicKey) {
      throw new Error("The local Mesh identity has no encryption public key.");
    }

    let requestBody: Record<string, unknown> | null = null;
    let requestReceivedAt = 0;
    const fetchImpl: typeof globalThis.fetch = Object.assign(
      async (
        _url: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ): Promise<Response> => {
        requestReceivedAt = Date.now();
        const parsedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requestBody = parsedBody;
        return Response.json({
          protocolVersion: 1,
          sessionId: "session-1",
          expiresAt: parsedBody["expiresAt"],
          encryptedPayload: encryptMeshPayload(
            { sessionToken: "s".repeat(32) },
            encryptionPublicKey,
          ),
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    const client = new MeshCommandExecutorClient({
      workspaceId: "workspace-1",
      directory: "/workspace/repo",
      executionNodeId: remoteNodeId,
      provider: "copilot",
      localUserId,
      channel: "acp",
      fetch: fetchImpl,
    });

    await client.openSession();

    if (!requestBody) {
      throw new Error("The Mesh session request was not captured.");
    }
    const expiresAt = new Date(String(requestBody["expiresAt"])).getTime();
    const channel = requestBody["channel"];
    if (channel !== "acp") {
      throw new Error(`Unexpected Mesh session channel: ${String(channel)}`);
    }
    expect<string>(channel).toBe("acp");
    const observedTtlMs = expiresAt - requestReceivedAt;
    expect(observedTtlMs).toBeLessThanOrEqual(MESH_ACP_SESSION_REQUEST_TTL_MS);
    expect(observedTtlMs).toBeGreaterThan(MESH_ACP_SESSION_REQUEST_TTL_MS - 1_000);
    expect(MESH_ACP_SESSION_TTL_MS - MESH_ACP_SESSION_REQUEST_TTL_MS).toBe(15_000);
  });
});
