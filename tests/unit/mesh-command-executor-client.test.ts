import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshCommandExecutorClient } from "../../src/core/mesh-command-executor-client";
import { encryptMeshPayload } from "../../src/core/mesh-payload-crypto";
import { closeDatabase, initializeDatabase } from "../../src/persistence/database";
import { ensureLocalMeshNodeIdentity } from "../../src/persistence/mesh-node-identity";
import { saveWorkerRegistration } from "../../src/persistence/mesh";
import { DEFAULT_EXECUTION_HOST_CAPABILITIES } from "../../src/shared/execution-host";
import { seedTestOwnerUser } from "../setup";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "clanky-mesh-client-"));
  closeDatabase();
  process.env["CLANKY_DATA_DIR"] = dataDir;
  await initializeDatabase();
  seedTestOwnerUser();
});

afterEach(async () => {
  closeDatabase();
  delete process.env["CLANKY_DATA_DIR"];
  await rm(dataDir, { recursive: true, force: true });
});

describe("MeshCommandExecutorClient", () => {
  test("shares concurrent session opening and encrypts managed environment", async () => {
    await ensureLocalMeshNodeIdentity();
    const workerEncryption = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicExponent: 0x10001,
    });
    const workerEncryptionPublicKey = workerEncryption.publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    await saveWorkerRegistration({
      workerNodeId: "worker-1",
      localUserId: "admin",
      workerInstanceName: "Worker",
      workerEndpoint: "http://worker.example",
      workerTransport: "http",
      workerPublicKey: "worker-public-key",
      workerFingerprint: "worker-fingerprint",
      workerEncryptionPublicKey,
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/workspace",
      workerCapabilities: DEFAULT_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
    });

    let releaseFirstRequest!: () => void;
    const firstRequestReleased = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    let requestStarted!: () => void;
    const firstRequestStarted = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    let sessionRequestCount = 0;
    let sessionRequest: Record<string, unknown> | undefined;
    const fetchImpl = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        sessionRequestCount += 1;
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sessionRequest = request;
        if (sessionRequestCount === 1) {
          requestStarted();
          await firstRequestReleased;
        }
        if (init?.signal?.aborted) {
          throw new DOMException("The request was aborted.", "AbortError");
        }
        const expiresAt = request["expiresAt"];
        return Response.json({
          protocolVersion: 1,
          sessionId: "session-1",
          expiresAt,
          encryptedPayload: encryptMeshPayload(
            { sessionToken: "s".repeat(32) },
            request["callerEncryptionPublicKey"] as string,
          ),
        });
      },
      { preconnect: () => undefined },
    ) as typeof globalThis.fetch;
    const client = new MeshCommandExecutorClient({
      workspaceId: "workspace-1",
      directory: "/workspace",
      executionNodeId: "worker-1",
      provider: "copilot",
      localUserId: "admin",
      channel: "acp",
      managedEnvironment: {
        CLANKY_BASE_URL: "https://clanky.example",
        CLANKY_API_KEY: "wapp_test_secret",
      },
      fetch: fetchImpl,
    });

    const firstOpen = client.openSession();
    await firstRequestStarted;
    const secondOpen = client.openSession();
    releaseFirstRequest();
    await Promise.all([firstOpen, secondOpen]);

    expect(sessionRequestCount).toBe(1);
    expect(sessionRequest?.["encryptedEnvironment"]).toMatchObject({
      __clankyMeshEncrypted: true,
    });
    expect(JSON.stringify(sessionRequest?.["encryptedEnvironment"])).not.toContain("wapp_test_secret");
    expect(client.getSessionConnection().sessionId).toBe("session-1");
    client.closeSession();
  });
});
