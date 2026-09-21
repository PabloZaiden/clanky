import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRuntimeConfig } from "@pablozaiden/webapp/server";
import { ControllerRelayService } from "../../src/core/controller-relay-service";
import { meshManager } from "../../src/core/mesh-manager";
import type {
  MeshRelayClientSocket,
  MeshRelayClientSocketFactory,
} from "../../src/core/mesh-relay-client-socket";
import {
  MeshRelayConnector,
} from "../../src/core/mesh-relay-connector";
import {
  MeshRelayConnectorManager,
} from "../../src/core/mesh-relay-connector-manager";
import { workspaceWorkerEnrollmentService } from "../../src/core/workspace-worker-enrollment-service";
import { getMeshRelayFingerprint } from "../../src/core/mesh-relay-identity";
import {
  startRelayServer,
  type StartedRelayServer,
} from "../../src/core/mesh-relay-server";
import { configureMeshRuntime } from "../../src/core/mesh-runtime";
import {
  closeDatabase,
  getDatabase,
  initializeDatabase,
} from "../../src/persistence/database";
import {
  saveControllerRelayPairing,
} from "../../src/persistence/controller-relay-pairing";
import {
  ensureLocalMeshNodeIdentity,
} from "../../src/persistence/mesh-node-identity";
import {
  saveWorkerRegistration,
} from "../../src/persistence/mesh";
import { POSIX_EXECUTION_HOST_CAPABILITIES } from "../../src/shared/execution-host";
import { pollUntil } from "../helpers/polling";
import { seedTestOwnerUser } from "../setup";

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

function createAckDroppingSocketFactory(state: {
  dropped: boolean;
  connections: number;
  deliveredAcks: number;
}): MeshRelayClientSocketFactory {
  return (url: string): MeshRelayClientSocket => {
    state.connections += 1;
    const socket = new WebSocket(url);
    const messageListeners = new Map<
      (event: MessageEvent) => void,
      (event: MessageEvent) => void
    >();
    return {
      get readyState(): number {
        return socket.readyState;
      },
      get bufferedAmount(): number {
        return socket.bufferedAmount;
      },
      get binaryType(): BinaryType {
        return socket.binaryType;
      },
      set binaryType(value: BinaryType) {
        socket.binaryType = value;
      },
      send(data: string | ArrayBufferView | ArrayBufferLike): void {
        if (typeof data === "string") {
          socket.send(data);
          return;
        }
        const bytes = ArrayBuffer.isView(data)
          ? Uint8Array.from(
              new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
            )
          : Uint8Array.from(new Uint8Array(data));
        socket.send(bytes);
      },
      close(code?: number, reason?: string): void {
        socket.close(code, reason);
      },
      addEventListener(type, listener): void {
        if (type === "message") {
          const messageListener = listener as (event: MessageEvent) => void;
          const wrapped = (event: MessageEvent): void => {
            if (!state.dropped && typeof event.data === "string") {
              const frame = JSON.parse(event.data) as Record<string, unknown>;
              if (frame["type"] === "authorization.ack") {
                state.dropped = true;
                return;
              }
            }
            if (typeof event.data === "string") {
              const frame = JSON.parse(event.data) as Record<string, unknown>;
              if (frame["type"] === "authorization.ack") {
                state.deliveredAcks += 1;
              }
            }
            messageListener(event);
          };
          messageListeners.set(messageListener, wrapped);
          socket.addEventListener("message", wrapped);
          return;
        }
        if (type === "close") {
          socket.addEventListener("close", listener as (event: CloseEvent) => void);
          return;
        }
        socket.addEventListener(type, listener as (event: Event) => void);
      },
      removeEventListener(type, listener): void {
        if (type === "message") {
          const messageListener = listener as (event: MessageEvent) => void;
          const wrapped = messageListeners.get(messageListener);
          if (wrapped) {
            messageListeners.delete(messageListener);
            socket.removeEventListener("message", wrapped);
          }
          return;
        }
        if (type === "close") {
          socket.removeEventListener("close", listener as (event: CloseEvent) => void);
          return;
        }
        socket.removeEventListener(type, listener as (event: Event) => void);
      },
    };
  };
}

describe("controller relay authorization recovery", () => {
  let dataDir = "";
  let relayDataDir = "";
  let relay: StartedRelayServer | undefined;
  let service: ControllerRelayService | undefined;

  beforeEach(async () => {
    relay = undefined;
    service = undefined;
    dataDir = await mkdtemp(join(tmpdir(), "clanky-controller-relay-sync-"));
    relayDataDir = await mkdtemp(join(tmpdir(), "clanky-relay-sync-"));
    closeDatabase();
    process.env["CLANKY_DATA_DIR"] = dataDir;
    await configureMeshRuntime({ meshWorker: false });
    await initializeDatabase();
    seedTestOwnerUser();
  });

  afterEach(async () => {
    await service?.stopRuntime();
    await service?.unpair();
    await relay?.stop();
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
    await rm(dataDir, { recursive: true, force: true });
    await rm(relayDataDir, { recursive: true, force: true });
  });

  test("reconnects and resends after an authorization acknowledgement is lost", async () => {
    const controllerIdentity = await ensureLocalMeshNodeIdentity();
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
      controllerFingerprint: controllerIdentity.fingerprint,
    });
    saveControllerRelayPairing({
      relayUrl,
      relayPublicKey: relay.identity.publicKey,
      relayFingerprint: relay.identity.fingerprint,
      controllerNodeId: controllerIdentity.nodeId,
      controllerFingerprint: controllerIdentity.fingerprint,
    });

    const workerKeys = generateKeyPairSync("ed25519");
    const workerPublicKey = workerKeys.publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    const workerFingerprint = getMeshRelayFingerprint(workerPublicKey);
    await saveWorkerRegistration({
      workerNodeId: "worker-retry",
      localUserId: "admin",
      workerInstanceName: "Retry worker",
      workerEndpoint: relayUrl,
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
        targetNodeId: "worker-retry",
        relayUrl,
        relayFingerprint: relay.identity.fingerprint,
      },
    });

    const socketState = { dropped: false, connections: 0, deliveredAcks: 0 };
    const manager = new MeshRelayConnectorManager({
      socketFactory: createAckDroppingSocketFactory(socketState),
      createConnector: (options) => new MeshRelayConnector({
        ...options,
        authorizationTimeoutMs: 50,
      }),
      baseDelayMs: 10,
      maxDelayMs: 20,
    });
    service = new ControllerRelayService({ manager });
    await service.startRuntime(
      async () => new Response("Not found", { status: 404 }),
    );

    await pollUntil(
      async () => ({
        status: await service!.getStatus(),
        authorized: relay!.store.listAuthorizedWorkers(),
        ...socketState,
      }),
      (state) =>
        state.dropped
        && state.connections >= 2
        && state.deliveredAcks >= 1
        && state.status.connected
        && state.authorized.length === 1,
      {
        description: "relay authorization to recover after an ambiguous ack",
        timeoutMs: 10_000,
        formatLastObserved: (state) => JSON.stringify({
          dropped: state.dropped,
          connections: state.connections,
          deliveredAcks: state.deliveredAcks,
          connected: state.status.connected,
          authorized: state.authorized.length,
        }),
      },
    );
    expect(relay.store.listAuthorizedWorkers()).toEqual([{
      nodeId: "worker-retry",
      publicKey: workerPublicKey,
      fingerprint: workerFingerprint,
    }]);
  });

  test("keeps the server available when a persisted relay URL is invalid", async () => {
    const controllerIdentity = await ensureLocalMeshNodeIdentity();
    saveControllerRelayPairing({
      relayUrl: "http://127.0.0.1:8080",
      relayPublicKey: controllerIdentity.publicKey,
      relayFingerprint: controllerIdentity.fingerprint,
      controllerNodeId: controllerIdentity.nodeId,
      controllerFingerprint: controllerIdentity.fingerprint,
    });
    getDatabase().query(`
      UPDATE mesh_controller_relay_pairing
      SET relay_url = 'http://relay.example'
      WHERE singleton = 1
    `).run();

    service = new ControllerRelayService();
    await expect(service.startRuntime(
      async () => new Response("Not found", { status: 404 }),
    )).resolves.toBeUndefined();

    expect(await service.getStatus()).toMatchObject({
      paired: true,
      relayUrl: "http://relay.example",
      connected: false,
      runtimeError: {
        code: "mesh_relay_url_invalid",
      },
    });
  });

  test("keeps controller startup available with a corrupt relay worker row", async () => {
    const controllerIdentity = await ensureLocalMeshNodeIdentity();
    saveControllerRelayPairing({
      relayUrl: "http://127.0.0.1:8080",
      relayPublicKey: controllerIdentity.publicKey,
      relayFingerprint: controllerIdentity.fingerprint,
      controllerNodeId: controllerIdentity.nodeId,
      controllerFingerprint: controllerIdentity.fingerprint,
    });
    const enrollment = workspaceWorkerEnrollmentService.create("admin", {
      name: "Corrupt route worker",
      ttlSeconds: 3_600,
      controller: {
        nodeId: controllerIdentity.nodeId,
        fingerprint: controllerIdentity.fingerprint,
      },
    });
    const workerKeys = generateKeyPairSync("ed25519");
    const workerPublicKey = workerKeys.publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    await saveWorkerRegistration({
      workerNodeId: "worker-corrupt-startup",
      localUserId: "admin",
      workerInstanceName: "Corrupt route worker",
      workerEndpoint: "http://127.0.0.1:8080",
      workerTransport: "http",
      workerPublicKey,
      workerFingerprint: getMeshRelayFingerprint(workerPublicKey),
      workerEncryptionPublicKey: null,
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/workspaces",
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
      registrationScope: "workspace",
      workspaceWorkerEnrollmentId: enrollment.enrollment.id,
      route: {
        kind: "relay",
        targetNodeId: "worker-corrupt-startup",
        relayUrl: "http://127.0.0.1:8080",
        relayFingerprint: controllerIdentity.fingerprint,
      },
    });
    workspaceWorkerEnrollmentService.markConnected(
      "admin",
      enrollment.enrollment.id,
      "worker-corrupt-startup",
    );
    getDatabase().query(`
      UPDATE mesh_worker_registrations
      SET relay_url = NULL
      WHERE worker_node_id = 'worker-corrupt-startup'
    `).run();

    await expect(meshManager.reconcileWorkspaceWorkerEnrollments("admin"))
      .resolves.toBeUndefined();
    service = new ControllerRelayService();
    await expect(service.startRuntime(
      async () => new Response("Not found", { status: 404 }),
    )).resolves.toBeUndefined();
    expect((await service.getStatus()).runtimeError?.code)
      .toBe("mesh_relay_route_invalid");

    await meshManager.revokeWorker("admin", "worker-corrupt-startup");
    await pollUntil(
      async () => await service!.getStatus(),
      (status) => status.runtimeError === null,
      {
        description: "controller relay runtime to recover after local revocation",
        timeoutMs: 5_000,
      },
    );
  });
});
