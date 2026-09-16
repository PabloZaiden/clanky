import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRuntimeConfig } from "@pablozaiden/webapp/server";
import { MESH_RELAY_DESCRIPTOR_PATH } from "@/shared/mesh-relay";
import {
  startRelayServer,
  type StartedRelayServer,
} from "../../src/core/mesh-relay-server";
import { controllerRelayService } from "../../src/core/controller-relay-service";
import { getMeshRelayFingerprint } from "../../src/core/mesh-relay-identity";
import { configureMeshRuntime } from "../../src/core/mesh-runtime";
import {
  closeDatabase,
  initializeDatabase,
} from "../../src/persistence/database";
import {
  ensureLocalMeshNodeIdentity,
} from "../../src/persistence/mesh-node-identity";
import { saveWorkerRegistration } from "../../src/persistence/mesh";
import { POSIX_EXECUTION_HOST_CAPABILITIES } from "@/shared/execution-host";
import { serveNativeApiRoutes } from "../native-api-server";
import { seedTestOwnerUser } from "../setup";
import { pollUntil } from "../helpers/polling";

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate a relay port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

describe("controller relay owner API", () => {
  let dataDir = "";
  let relayDataDir = "";
  let relay: StartedRelayServer | undefined;
  let api: ReturnType<typeof serveNativeApiRoutes> | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clanky-controller-relay-"));
    relayDataDir = await mkdtemp(join(tmpdir(), "clanky-relay-api-"));
    closeDatabase();
    process.env["CLANKY_DATA_DIR"] = dataDir;
    await configureMeshRuntime({ meshWorker: false });
    await initializeDatabase();
    seedTestOwnerUser();
    await controllerRelayService.startRuntime(
      async () => new Response("Not found", { status: 404 }),
    );
    api = serveNativeApiRoutes();
  });

  afterEach(async () => {
    api?.stop(true);
    await controllerRelayService.stopRuntime();
    await controllerRelayService.unpair();
    await relay?.stop();
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
    await rm(dataDir, { recursive: true, force: true });
    await rm(relayDataDir, { recursive: true, force: true });
  });

  async function startRelay(controllerFingerprint: string): Promise<string> {
    const port = await availablePort();
    const relayUrl = `http://127.0.0.1:${String(port)}`;
    const runtimeConfig = readRuntimeConfig({
      appName: "Clanky Relay",
      envPrefix: "CLANKY",
      appDirectoryName: ".clanky",
      environment: {
        CLANKY_DATA_DIR: relayDataDir,
        CLANKY_HOST: "127.0.0.1",
        CLANKY_PORT: String(port),
        CLANKY_LOG_LEVEL: "fatal",
      },
    });
    relay = await startRelayServer({
      runtimeConfig,
      controllerFingerprint,
    });
    return relayUrl;
  }

  test("pairs live, persists public status, and leaves remote reset separate", async () => {
    const identity = await ensureLocalMeshNodeIdentity();
    const workerKeys = generateKeyPairSync("ed25519");
    const workerPublicKey = workerKeys.publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    const workerFingerprint = getMeshRelayFingerprint(workerPublicKey);
    const relayUrl = await startRelay(identity.fingerprint);
    await saveWorkerRegistration({
      workerNodeId: "worker-live",
      localUserId: "admin",
      workerInstanceName: "Live worker",
      workerEndpoint: "http://127.0.0.1:4000",
      workerTransport: "http",
      workerPublicKey,
      workerFingerprint,
      workerEncryptionPublicKey: null,
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/workspaces",
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
      route: {
        kind: "relay",
        targetNodeId: "worker-live",
        relayUrl,
        relayFingerprint: relay!.identity.fingerprint,
      },
    });
    const executionHostsResponse = await fetch(`${api!.url}/api/execution-hosts`);
    expect(executionHostsResponse.status).toBe(200);
    expect(await executionHostsResponse.json()).toContainEqual(expect.objectContaining({
      ref: { kind: "mesh", nodeId: "worker-live" },
      endpoint: "http://127.0.0.1:4000",
      meshRouteKind: "relay",
    }));
    const health = await fetch(`${relayUrl}/api/health`);
    expect(health.ok).toBe(true);
    const before = await fetch(`${relayUrl}${MESH_RELAY_DESCRIPTOR_PATH}`);
    expect((await before.json() as { controllerNodeId: string | null }).controllerNodeId)
      .toBeNull();

    const paired = await fetch(`${api!.url}/api/mesh/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relayUrl }),
    });
    expect(paired.status).toBe(201);
    expect(await paired.json()).toEqual({
      paired: true,
      relayUrl,
      relayFingerprint: relay!.identity.fingerprint,
      controllerFingerprint: identity.fingerprint,
      connected: true,
      runtimeError: null,
      pairedAt: expect.any(String),
      updatedAt: expect.any(String),
      bootstrapEnvironment:
        `CLANKY_RELAY_CONTROLLER_FINGERPRINT=${identity.fingerprint}`,
    });

    const status = await fetch(`${api!.url}/api/mesh/relay`);
    const statusBody = await status.json() as Record<string, unknown>;
    expect(statusBody["relayPublicKey"]).toBeUndefined();
    expect(statusBody["paired"]).toBe(true);
    expect(relay!.store.listAuthorizedWorkers()).toEqual([{
      nodeId: "worker-live",
      publicKey: workerPublicKey,
      fingerprint: workerFingerprint,
    }]);

    await controllerRelayService.stopRuntime();
    expect((await controllerRelayService.getStatus()).connected).toBe(false);
    await controllerRelayService.startRuntime(
      async () => new Response("Not found", { status: 404 }),
    );
    await pollUntil(
      async () => (await controllerRelayService.getStatus()).connected,
      (connected) => connected,
      { description: "the persisted controller relay connection to restart" },
    );

    const descriptor = await fetch(`${relayUrl}${MESH_RELAY_DESCRIPTOR_PATH}`);
    expect((await descriptor.json() as { controllerNodeId: string }).controllerNodeId)
      .toBe(identity.nodeId);

    const unpaired = await fetch(`${api!.url}/api/mesh/relay`, {
      method: "DELETE",
    });
    expect((await unpaired.json() as { paired: boolean }).paired).toBe(false);
    const remoteDescriptor = await fetch(`${relayUrl}${MESH_RELAY_DESCRIPTOR_PATH}`);
    expect(
      (await remoteDescriptor.json() as { controllerNodeId: string }).controllerNodeId,
    ).toBe(identity.nodeId);
  });

  test("rejects a relay configured for a different controller", async () => {
    const relayUrl = await startRelay(`sha256:${"0".repeat(64)}`);
    const response = await fetch(`${api!.url}/api/mesh/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relayUrl }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "mesh_relay_controller_mismatch",
    });
  });
});
