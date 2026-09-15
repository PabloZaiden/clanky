import { afterEach, describe, expect, jest, test } from "bun:test";
import { generateKeyPairSync, sign as signPayload } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MeshRelayAuthFrame,
  MeshRelayChallengeFrame,
  MeshRelayPeerIdentity,
} from "../../src/shared/mesh-relay";
import {
  MESH_RELAY_PROTOCOL_VERSION,
} from "../../src/shared/mesh-relay";
import {
  MeshRelayBroker,
  type MeshRelaySocket,
} from "../../src/core/mesh-relay-broker";
import {
  getMeshRelayFingerprint,
  type MeshRelaySigningIdentity,
} from "../../src/core/mesh-relay-identity";
import { buildMeshRelayAuthSigningPayload } from "../../src/core/mesh-relay-protocol";
import { MeshRelayStore } from "../../src/core/mesh-relay-store";

class RecordingRelaySocket implements MeshRelaySocket {
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  send(data: string | Uint8Array): number {
    this.sent.push(typeof data === "string"
      ? data
      : new TextDecoder().decode(data));
    return 1;
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  getBufferedAmount(): number {
    return 0;
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  }
}

interface TestIdentity {
  peer: MeshRelayPeerIdentity;
  sign(payload: string): string;
}

function createIdentity(nodeId: string): TestIdentity {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey
    .export({ format: "pem", type: "spki" })
    .toString();
  return {
    peer: {
      nodeId,
      publicKey,
      fingerprint: getMeshRelayFingerprint(publicKey),
    },
    sign: (payload: string) =>
      signPayload(null, Buffer.from(payload, "utf8"), keys.privateKey)
        .toString("base64url"),
  };
}

function createRelayIdentity(): MeshRelaySigningIdentity {
  const identity = createIdentity("relay");
  return {
    publicKey: identity.peer.publicKey,
    fingerprint: identity.peer.fingerprint,
    createdAt: new Date().toISOString(),
    sign: identity.sign,
  };
}

function identityBytes(workers: readonly MeshRelayPeerIdentity[]): number {
  return workers.reduce(
    (total, worker) => total + Buffer.byteLength(JSON.stringify(worker), "utf8"),
    0,
  );
}

function sendAuthorization(
  broker: MeshRelayBroker,
  connectionId: string,
  transactionId: string,
  workers: readonly MeshRelayPeerIdentity[],
  chunkSizes: readonly number[],
): void {
  broker.handleControlMessage(connectionId, JSON.stringify({
    protocolVersion: MESH_RELAY_PROTOCOL_VERSION,
    type: "authorization.begin",
    transactionId,
    workerCount: workers.length,
    identityBytes: identityBytes(workers),
  }));
  let offset = 0;
  for (const chunkSize of chunkSizes) {
    broker.handleControlMessage(connectionId, JSON.stringify({
      protocolVersion: MESH_RELAY_PROTOCOL_VERSION,
      type: "authorization.chunk",
      transactionId,
      workers: workers.slice(offset, offset + chunkSize),
    }));
    offset += chunkSize;
  }
  expect(offset).toBe(workers.length);
}

function authenticateController(
  broker: MeshRelayBroker,
  socket: RecordingRelaySocket,
  identity: TestIdentity,
): string {
  const connectionId = broker.openControl(socket);
  const challenge = socket.frames()[0] as unknown as MeshRelayChallengeFrame;
  const unsigned = {
    protocolVersion: MESH_RELAY_PROTOCOL_VERSION,
    type: "auth",
    role: "controller",
    nodeId: identity.peer.nodeId,
    publicKey: identity.peer.publicKey,
    fingerprint: identity.peer.fingerprint,
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    relayFingerprint: challenge.relayFingerprint,
    expiresAt: challenge.expiresAt,
  } as const;
  const auth: MeshRelayAuthFrame = {
    ...unsigned,
    signature: identity.sign(buildMeshRelayAuthSigningPayload(unsigned)),
  };
  broker.handleControlMessage(connectionId, JSON.stringify(auth));
  expect(socket.frames().at(-1)?.["type"]).toBe("auth.ok");
  return connectionId;
}

afterEach(() => {
  jest.useRealTimers();
});

describe("Mesh relay authorization transactions", () => {
  test("applies multi-chunk replacement atomically and revokes removed workers", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clanky-relay-authorization-"));
    const store = new MeshRelayStore(dataDir);
    const controller = createIdentity("controller");
    const broker = new MeshRelayBroker({
      identity: createRelayIdentity(),
      store,
      controllerFingerprint: controller.peer.fingerprint,
    });
    const socket = new RecordingRelaySocket();
    try {
      const connectionId = authenticateController(broker, socket, controller);
      const original = createIdentity("worker-original").peer;
      sendAuthorization(
        broker,
        connectionId,
        "generation-original",
        [original],
        [1],
      );
      broker.handleControlMessage(connectionId, JSON.stringify({
        protocolVersion: MESH_RELAY_PROTOCOL_VERSION,
        type: "authorization.commit",
        transactionId: "generation-original",
      }));
      expect(store.listAuthorizedWorkers()).toEqual([original]);

      const replacement = [
        createIdentity("worker-a").peer,
        createIdentity("worker-b").peer,
      ];
      sendAuthorization(
        broker,
        connectionId,
        "generation-multi",
        replacement,
        [1, 1],
      );
      expect(store.listAuthorizedWorkers()).toEqual([original]);

      broker.handleControlMessage(connectionId, JSON.stringify({
        protocolVersion: MESH_RELAY_PROTOCOL_VERSION,
        type: "authorization.commit",
        transactionId: "generation-multi",
      }));
      expect(store.listAuthorizedWorkers()).toEqual(replacement);

      sendAuthorization(
        broker,
        connectionId,
        "generation-revoke",
        [replacement[1]!],
        [1],
      );
      broker.handleControlMessage(connectionId, JSON.stringify({
        protocolVersion: MESH_RELAY_PROTOCOL_VERSION,
        type: "authorization.commit",
        transactionId: "generation-revoke",
      }));
      expect(store.listAuthorizedWorkers()).toEqual([replacement[1]!]);
    } finally {
      broker.stop();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("expires incomplete authorization without changing persisted workers", async () => {
    jest.useFakeTimers();
    const dataDir = await mkdtemp(join(tmpdir(), "clanky-relay-authorization-"));
    const store = new MeshRelayStore(dataDir);
    const controller = createIdentity("controller");
    const broker = new MeshRelayBroker({
      identity: createRelayIdentity(),
      store,
      controllerFingerprint: controller.peer.fingerprint,
      authorizationTransactionTimeoutMs: 1_000,
    });
    const socket = new RecordingRelaySocket();
    try {
      const connectionId = authenticateController(broker, socket, controller);
      const original = createIdentity("worker-original").peer;
      store.replaceAuthorizedWorkers([original]);
      const staged = createIdentity("worker-staged").peer;
      sendAuthorization(
        broker,
        connectionId,
        "generation-expiring",
        [staged],
        [1],
      );
      expect(store.listAuthorizedWorkers()).toEqual([original]);

      jest.advanceTimersByTime(1_000);
      broker.handleControlMessage(connectionId, JSON.stringify({
        protocolVersion: MESH_RELAY_PROTOCOL_VERSION,
        type: "authorization.commit",
        transactionId: "generation-expiring",
      }));

      expect(store.listAuthorizedWorkers()).toEqual([original]);
      expect(socket.frames().at(-1)).toMatchObject({
        type: "stream.error",
        requestId: "generation-expiring",
        code: "relay_authorization_transaction_missing",
      });
    } finally {
      broker.stop();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
