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
  let relayDataDirs: string[] = [];
  let relays: StartedRelayServer[] = [];
  let relay: StartedRelayServer | undefined;
  let api: ReturnType<typeof serveNativeApiRoutes> | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clanky-controller-relay-"));
    relayDataDirs = [];
    relays = [];
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
    await Promise.all(relays.map(async (server) => await server.stop()));
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
    await rm(dataDir, { recursive: true, force: true });
    await Promise.all(
      relayDataDirs.map(async (directory) =>
        await rm(directory, { recursive: true, force: true })),
    );
  });

  async function startRelay(controllerFingerprint: string): Promise<string> {
    const port = await availablePort();
    const relayUrl = `http://127.0.0.1:${String(port)}`;
    const relayDataDir = await mkdtemp(join(tmpdir(), "clanky-relay-api-"));
    relayDataDirs.push(relayDataDir);
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
    relays.push(relay);
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
      workerEncryptionPublicKey: "test-encryption-key",
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
      body: JSON.stringify({ name: "east", relayUrl }),
    });
    expect(paired.status).toBe(201);
    expect(await paired.json()).toEqual({
      controllerFingerprint: identity.fingerprint,
      bootstrapEnvironment:
        `CLANKY_RELAY_CONTROLLER_FINGERPRINT=${identity.fingerprint}`,
      primaryName: "east",
      relays: [{
        name: "east",
        isPrimary: true,
        relayUrl,
        relayFingerprint: relay!.identity.fingerprint,
        connected: true,
        runtimeError: null,
        pairedAt: expect.any(String),
        updatedAt: expect.any(String),
        relayBinaryVersion: expect.any(String),
        relaySupportedProtocolVersions: [5],
        relayPreferredProtocolVersion: 5,
        relayNegotiatedProtocolVersion: 5,
      }],
    });

    const status = await fetch(`${api!.url}/api/mesh/relay`);
    const statusBody = await status.json() as Record<string, unknown>;
    expect(statusBody["relayPublicKey"]).toBeUndefined();
    expect(statusBody["primaryName"]).toBe("east");
    expect(relay!.store.listAuthorizedWorkers()).toEqual([{
      nodeId: "worker-live",
      publicKey: workerPublicKey,
      fingerprint: workerFingerprint,
    }]);

    await controllerRelayService.stopRuntime();
    expect((await controllerRelayService.getStatus()).relays[0]?.connected).toBe(false);
    await controllerRelayService.startRuntime(
      async () => new Response("Not found", { status: 404 }),
    );
    await pollUntil(
      async () => (await controllerRelayService.getStatus()).relays[0]?.connected,
      (connected) => connected === true,
      { description: "the persisted controller relay connection to restart" },
    );

    const descriptor = await fetch(`${relayUrl}${MESH_RELAY_DESCRIPTOR_PATH}`);
    expect((await descriptor.json() as { controllerNodeId: string }).controllerNodeId)
      .toBe(identity.nodeId);

    const unpaired = await fetch(`${api!.url}/api/mesh/relay/east`, {
      method: "DELETE",
    });
    expect(await unpaired.json()).toMatchObject({
      primaryName: null,
      relays: [],
    });
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
      body: JSON.stringify({ name: "east", relayUrl }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "mesh_relay_controller_mismatch",
    });
  });

  test("pairs independent named relays and changes only the invitation default", async () => {
    const identity = await ensureLocalMeshNodeIdentity();
    const eastUrl = await startRelay(identity.fingerprint);
    const eastRelay = relay!;
    const westUrl = await startRelay(identity.fingerprint);
    const westRelay = relay!;
    const pair = async (name: string, relayUrl: string) => await fetch(
      `${api!.url}/api/mesh/relay`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, relayUrl }),
      },
    );
    expect((await pair("east", eastUrl)).status).toBe(201);
    expect((await pair("west", westUrl)).status).toBe(201);
    const status = await fetch(`${api!.url}/api/mesh/relay`);
    expect(await status.json()).toMatchObject({
      primaryName: "east",
      relays: [
        { name: "east", isPrimary: true, connected: true, relayUrl: eastUrl },
        { name: "west", isPrimary: false, connected: true, relayUrl: westUrl },
      ],
    });
    expect(eastRelay.store.listAuthorizedWorkers()).toEqual([]);
    expect(westRelay.store.listAuthorizedWorkers()).toEqual([]);

    const duplicate = await pair("another-name", eastUrl);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: "mesh_relay_already_paired" });
    const missingName = await fetch(`${api!.url}/api/mesh/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relayUrl: westUrl }),
    });
    expect(missingName.status).toBe(400);

    const createToken = async (relayName?: string) => await fetch(
      `${api!.url}/api/mesh/enrollment-tokens`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "New worker",
          route: "relay",
          ...(relayName ? { relayName } : {}),
        }),
      },
    );
    const eastInvite = await createToken();
    expect(eastInvite.status).toBe(201);
    expect((await eastInvite.json() as { workerJoinCommand: string })
      .workerJoinCommand).toContain(`'${eastUrl}'`);
    const namedInvite = await createToken("west");
    expect(namedInvite.status).toBe(201);
    expect((await namedInvite.json() as { workerJoinCommand: string })
      .workerJoinCommand).toContain(`'${westUrl}'`);
    const dedicatedInvite = await fetch(`${api!.url}/api/workspace-worker-enrollments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Dedicated worker",
        route: "relay",
        relayName: "west",
      }),
    });
    expect(dedicatedInvite.status).toBe(201);
    expect((await dedicatedInvite.json() as { workerJoinCommand: string })
      .workerJoinCommand).toContain(`'${westUrl}'`);
    const unknownInvite = await createToken("missing");
    expect(unknownInvite.status).toBe(404);

    const primary = await fetch(`${api!.url}/api/mesh/relay/primary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "west" }),
    });
    expect(primary.status).toBe(200);
    expect(await primary.json()).toMatchObject({
      primaryName: "west",
      relays: [
        { name: "west", isPrimary: true, connected: true },
        { name: "east", isPrimary: false, connected: true },
      ],
    });
    const westInvite = await createToken();
    expect(westInvite.status).toBe(201);
    expect((await westInvite.json() as { workerJoinCommand: string })
      .workerJoinCommand).toContain(`'${westUrl}'`);

    const removed = await fetch(`${api!.url}/api/mesh/relay/west`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({
      primaryName: null,
      relays: [{ name: "east", connected: true }],
    });
    expect((await createToken()).status).toBe(409);
    expect((await createToken("east")).status).toBe(201);
    expect((await fetch(`${api!.url}/api/mesh/relay/primary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "east" }),
    })).status).toBe(200);
  });
});
