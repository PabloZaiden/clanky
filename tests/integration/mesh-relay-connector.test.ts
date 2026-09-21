/**
 * Node-side Mesh relay connector behaviour against a real relay server.
 *
 * These tests drive the public relay protocol boundary end to end: challenge
 * verification and signed authentication, worker authorization promotion,
 * ticketed HTTP streams with streaming bodies, socket streams with preserved
 * frame boundaries, relay error taxonomy, and reconnect after network loss.
 * Only the destination application (`dispatch` and the socket peer) is
 * substituted, because that is the genuine external seam.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer } from "node:net";
import { generateKeyPairSync, sign as signPayload } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRuntimeConfig } from "@pablozaiden/webapp/server";
import {
  MESH_RELAY_PROTOCOL_VERSION,
  type MeshRelayPeerIdentity,
  type MeshRelayStreamOfferFrame,
} from "@/shared/mesh-relay";
import type {
  MeshRelayPeerRoute,
} from "@/shared/mesh";
import { startRelayServer, type StartedRelayServer } from "../../src/core/mesh-relay-server";
import { getMeshRelayFingerprint } from "../../src/core/mesh-relay-identity";
import {
  MeshRelayConnector,
  type MeshRelayConnectorIdentity,
  type MeshRelayInboundHandler,
  type MeshRelayOfferContext,
} from "../../src/core/mesh-relay-connector";
import type { MeshRelayClientSocket } from "../../src/core/mesh-relay-client-socket";
import { createMeshRelayInboundHandler } from "../../src/core/mesh-relay-inbound";
import { createMeshRelayPeerTransport } from "../../src/core/mesh-relay-transport";
import { MeshRelayStreamError } from "../../src/core/mesh-relay-errors";
import { MeshRelayConnectorManager } from "../../src/core/mesh-relay-connector-manager";
import { DomainError } from "../../src/domain/domain-error";
import {
  MESH_RELAY_MAX_CONTROL_FRAME_BYTES,
  MESH_RELAY_MAX_ENROLLMENT_BODY_BYTES,
} from "../../src/core/mesh-relay-policy";
import { createMeshRelayEnrollmentAdmission } from "../../src/core/mesh-relay-admission";
import { pollUntil } from "../helpers/polling";

const FILE_CHUNK = 64 * 1024;
const FILE_CHUNKS = 6;

interface TestIdentity extends MeshRelayConnectorIdentity {
  peer: MeshRelayPeerIdentity;
}

function createIdentity(nodeId: string): TestIdentity {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const fingerprint = getMeshRelayFingerprint(publicKey);
  return {
    nodeId,
    publicKey,
    fingerprint,
    peer: { nodeId, publicKey, fingerprint },
    sign: async (payload: string) =>
      signPayload(null, Buffer.from(payload, "utf8"), keys.privateKey).toString("base64url"),
  };
}

async function createEnrollmentAdmission(
  controller: TestIdentity,
): Promise<string> {
  return await createMeshRelayEnrollmentAdmission({
    controllerNodeId: controller.nodeId,
    controllerFingerprint: controller.fingerprint,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sign: controller.sign,
  });
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate a port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function fileStream(): ReadableStream<Uint8Array> {
  let emitted = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller): void {
      if (emitted >= FILE_CHUNKS) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(FILE_CHUNK).fill(emitted % 251));
      emitted += 1;
    },
  });
}

interface ManualRelaySocket extends MeshRelayClientSocket {
  emitMessage(data: string): void;
}

function createManualRelaySocket(): ManualRelaySocket {
  const target = new EventTarget();
  let readyState: number = WebSocket.OPEN;
  return {
    get readyState(): number {
      return readyState;
    },
    bufferedAmount: 0,
    binaryType: "blob",
    send(): void {},
    close(code = 1000, reason = ""): void {
      readyState = WebSocket.CLOSED;
      target.dispatchEvent(new CloseEvent("close", { code, reason }));
    },
    addEventListener(type, listener): void {
      target.addEventListener(type, listener as EventListener);
    },
    removeEventListener(type, listener): void {
      target.removeEventListener(type, listener as EventListener);
    },
    emitMessage(data: string): void {
      target.dispatchEvent(new MessageEvent("message", { data }));
    },
  };
}

async function dispatch(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname === "/api/mesh/internal/enrollment") {
    return Response.json({ bytesReceived: (await request.arrayBuffer()).byteLength });
  }
  if (url.pathname === "/api/mesh/internal/health") {
    const payload = await request.json() as Record<string, unknown>;
    return Response.json(
      { senderNodeId: payload["senderNodeId"], nonce: payload["nonce"] },
      { status: 202, headers: { "x-mesh-test": "health" } },
    );
  }
  if (url.pathname === "/api/mesh/internal/execution/file") {
    if (request.method === "POST") {
      let received = 0;
      const reader = request.body!.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
      }
      return Response.json({ bytesWritten: received });
    }
    return new Response(fileStream(), {
      headers: { "content-type": "application/octet-stream" },
    });
  }
  if (url.pathname === "/api/mesh/internal/kill") {
    return Response.json(
      { error: "mesh_peer_not_trusted", message: "Not trusted." },
      { status: 403 },
    );
  }
  return undefined;
}

/**
 * Worker-side inbound handler. HTTP uses the production handler; socket
 * streams echo frames because the real gateways need worker runtime state.
 */
function workerInbound(): MeshRelayInboundHandler {
  const http = createMeshRelayInboundHandler({ role: "worker", dispatch });
  return {
    async handleOffer(
      offer: MeshRelayStreamOfferFrame,
      context: MeshRelayOfferContext,
    ): Promise<void> {
      if (offer.kind === "http") {
        await http.handleOffer(offer, context);
        return;
      }
      const stream = await context.openDataStream();
      try {
        while (true) {
          const item = await stream.next();
          if (item.kind === "closed") {
            return;
          }
          if (item.kind === "text") {
            if (item.text === "bye") {
              stream.close(1000, "peer closed");
              return;
            }
            stream.send(`echo:${item.text}`);
            continue;
          }
          stream.send(item.bytes);
        }
      } finally {
        stream.dispose();
      }
    },
  };
}

describe("Mesh relay connector", () => {
  let dataDir = "";
  let relay: StartedRelayServer;
  let relayUrl = "";
  let controller: MeshRelayConnector;
  let worker: MeshRelayConnector;
  const controllerIdentity = createIdentity("controller-node");
  const workerIdentity = createIdentity("worker-node");

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clanky-relay-connector-"));
    const port = await availablePort();
    relayUrl = `http://127.0.0.1:${String(port)}`;
    const runtimeConfig = readRuntimeConfig({
      appName: "Clanky Relay",
      envPrefix: "CLANKY",
      appDirectoryName: ".clanky",
      environment: {
        CLANKY_DATA_DIR: dataDir,
        CLANKY_HOST: "127.0.0.1",
        CLANKY_PORT: String(port),
        CLANKY_LOG_LEVEL: "fatal",
      },
    });
    relay = await startRelayServer({
      runtimeConfig,
      dataDir,
      controllerFingerprint: controllerIdentity.fingerprint,
    });

    controller = new MeshRelayConnector({
      config: {
        relayUrl,
        relayFingerprint: relay.identity.fingerprint,
        role: "controller",
        targetNodeId: workerIdentity.nodeId,
      },
      identity: controllerIdentity,
      inbound: createMeshRelayInboundHandler({ role: "controller", dispatch }),
    });
    await controller.connect();
    worker = new MeshRelayConnector({
      config: {
        relayUrl,
        relayFingerprint: relay.identity.fingerprint,
        role: "worker",
        targetNodeId: controllerIdentity.nodeId,
        enrollmentAdmission: await createEnrollmentAdmission(controllerIdentity),
      },
      identity: workerIdentity,
      inbound: workerInbound(),
    });
    const workerAuth = await worker.connect();
    expect(workerAuth.workerStatus).toBe("pending");
    const acked = await controller.replaceAuthorization([workerIdentity.peer]);
    expect(acked).toBe(1);
    await pollUntil(
      () => worker.workerStatus,
      (status) => status === "authorized",
      { description: "the worker relay promotion to authorized" },
    );
  });

  afterAll(async () => {
    controller?.close();
    worker?.close();
    await relay?.stop();
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  function route(): MeshRelayPeerRoute {
    return {
      kind: "relay",
      targetNodeId: workerIdentity.nodeId,
      relayUrl,
      relayFingerprint: relay.identity.fingerprint,
    };
  }

  function transport() {
    return createMeshRelayPeerTransport(() => controller);
  }

  // The relay handshake is a security boundary: an acknowledgement is only
  // trusted after a signed response to a validated challenge was sent.
  test("rejects an unsolicited authentication acknowledgement", async () => {
    const socket = createManualRelaySocket();
    const connector = new MeshRelayConnector({
      config: {
        relayUrl: "http://127.0.0.1:8080",
        relayFingerprint: relay.identity.fingerprint,
        role: "controller",
      },
      identity: createIdentity("unsolicited-auth-controller"),
      socketFactory: () => socket,
    });
    const connecting = connector.connect();

    socket.emitMessage(JSON.stringify({
      protocolVersion: MESH_RELAY_PROTOCOL_VERSION,
      type: "auth.ok",
      connectionId: "unsolicited-connection",
      role: "controller",
      nodeId: "unsolicited-auth-controller",
    }));

    await expect(connecting).rejects.toMatchObject({
      code: "mesh_relay_auth_invalid",
    });
    expect(connector.status).toBe("closed");
  });

  test("replaces and revokes an authorization snapshot larger than one frame", async () => {
    const revocableIdentity = createIdentity("worker-revocable");
    const revocable = new MeshRelayConnector({
      config: {
        relayUrl,
        relayFingerprint: relay.identity.fingerprint,
        role: "worker",
        targetNodeId: controllerIdentity.nodeId,
        enrollmentAdmission: await createEnrollmentAdmission(controllerIdentity),
      },
      identity: revocableIdentity,
    });
    const additionalWorkers = Array.from({ length: 699 }, (_, index) =>
      createIdentity(
        `worker-bulk-${String(index).padStart(4, "0")}-${"x".repeat(175)}`,
      ).peer);
    const workers = [
      workerIdentity.peer,
      revocableIdentity.peer,
      ...additionalWorkers,
    ];
    try {
      expect((await revocable.connect()).workerStatus).toBe("pending");
      expect(Buffer.byteLength(JSON.stringify({
        protocolVersion: MESH_RELAY_PROTOCOL_VERSION,
        type: "authorization.chunk",
        transactionId: "single-frame",
        workers,
      }), "utf8")).toBeGreaterThan(MESH_RELAY_MAX_CONTROL_FRAME_BYTES);

      expect(await controller.replaceAuthorization(workers)).toBe(workers.length);
      expect(relay.store.listAuthorizedWorkers()).toHaveLength(workers.length);
      await pollUntil(
        () => revocable.workerStatus,
        (status) => status === "authorized",
        { description: "the multi-chunk worker authorization promotion" },
      );

      expect(await controller.replaceAuthorization([workerIdentity.peer])).toBe(1);
      expect(relay.store.listAuthorizedWorkers()).toEqual([workerIdentity.peer]);
      await pollUntil(
        () => revocable.status,
        (status) => status === "closed",
        { description: "the removed worker authorization to be revoked" },
      );
    } finally {
      revocable.close();
      await controller.replaceAuthorization([workerIdentity.peer]);
    }
  });

  test("relays an HTTP request and its exact status, headers and body", async () => {
    const response = await transport().request(route(), "/api/mesh/internal/health", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clanky-mesh-node-id": controllerIdentity.nodeId,
        "x-clanky-mesh-request-id": "nonce-1",
      },
      body: JSON.stringify({ senderNodeId: controllerIdentity.nodeId, nonce: "nonce-1" }),
    });

    expect(response.status).toBe(202);
    expect(response.headers.get("x-mesh-test")).toBe("health");
    expect(await response.json()).toEqual({
      senderNodeId: controllerIdentity.nodeId,
      nonce: "nonce-1",
    });
  });

  test("passes a peer error status and body through unchanged", async () => {
    const response = await transport().request(route(), "/api/mesh/internal/kill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ controllerNodeId: controllerIdentity.nodeId }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "mesh_peer_not_trusted",
      message: "Not trusted.",
    });
  });

  test("cancels a stalled upload when the peer responds early", async () => {
    let uploadCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array(FILE_CHUNK));
        controller.enqueue(new Uint8Array(FILE_CHUNK));
        controller.enqueue(new Uint8Array(FILE_CHUNK));
      },
      pull: () => new Promise<void>(() => {}),
      cancel: () => {
        uploadCancelled = true;
      },
    });
    const response = await transport().request(
      route(),
      "/api/mesh/internal/kill",
      { method: "POST", body },
    );

    expect(response.status).toBe(403);
    await response.body?.cancel();
    await pollUntil(
      () => uploadCancelled,
      (cancelled) => cancelled,
      { description: "the stalled relay upload to be cancelled" },
    );
    await pollUntil(
      () => relay.broker.connectionCount,
      (count) => count === 2,
      { description: "the early-response relay stream to release its data sockets" },
    );
  });

  test("audits peer dispatch failures separately from completed requests", async () => {
    await expect(transport().request(
      route(),
      "/api/mesh/internal/health",
      { method: "POST", body: "{" },
    )).rejects.toMatchObject({ code: "mesh_relay_dispatch_failed" });

    const database = new Database(relay.store.databasePath, {
      readonly: true,
      strict: true,
    });
    try {
      const audit = await pollUntil(
        () => database.query(`
          SELECT outcome, error_code
          FROM relay_stream_audit
          WHERE path = '/api/mesh/internal/health'
          ORDER BY id DESC
          LIMIT 1
        `).get() as { outcome: string; error_code: string | null } | null,
        (row) => row?.outcome === "dispatch_failed",
        {
          description: "the failed relay dispatch audit",
          formatLastObserved: (row) => JSON.stringify(row),
        },
      );
      expect(audit).toEqual({
        outcome: "dispatch_failed",
        error_code: "relay_stream_dispatch_failed",
      });
    } finally {
      database.close();
    }
  });

  test("streams a large response body without buffering it whole", async () => {
    const response = await transport().request(
      route(),
      "/api/mesh/internal/execution/file?path=%2Ftmp%2Fbig.bin",
      { method: "GET", headers: { "x-clanky-mesh-session-id": "session" } },
    );

    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let total = 0;
    let chunks = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      chunks += 1;
    }
    expect(total).toBe(FILE_CHUNK * FILE_CHUNKS);
    expect(chunks).toBeGreaterThan(1);
  });

  test("streams a large request body to the peer", async () => {
    const response = await transport().request(
      route(),
      "/api/mesh/internal/execution/file?path=%2Ftmp%2Fupload.bin",
      {
        method: "POST",
        headers: { "x-clanky-mesh-session-id": "session" },
        body: fileStream(),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytesWritten: FILE_CHUNK * FILE_CHUNKS });
  });

  test("refuses routes that the relay policy does not allow", async () => {
    await expect(transport().request(route(), "/api/tasks", { method: "GET" }))
      .rejects.toMatchObject({ code: "mesh_relay_route_forbidden" });
  });

  test("lets an authorized worker re-enroll but bounds its request body", async () => {
    const workerTransport = createMeshRelayPeerTransport(() => worker);
    const controllerRoute: MeshRelayPeerRoute = {
      kind: "relay",
      targetNodeId: controllerIdentity.nodeId,
      relayUrl,
      relayFingerprint: relay.identity.fingerprint,
    };
    const accepted = await workerTransport.request(
      controllerRoute,
      "/api/mesh/internal/enrollment",
      {
        method: "POST",
        body: new Uint8Array(1_024),
      },
    );
    expect(await accepted.json()).toEqual({ bytesReceived: 1_024 });

    await expect(workerTransport.request(
      controllerRoute,
      "/api/mesh/internal/enrollment",
      {
        method: "POST",
        body: new Uint8Array(MESH_RELAY_MAX_ENROLLMENT_BODY_BYTES + 1),
      },
    )).rejects.toBeInstanceOf(MeshRelayStreamError);
  });

  test("cancels a relay request while its stream is opening", async () => {
    const dormantIdentity = createIdentity("worker-dormant-node");
    const dormant = new MeshRelayConnector({
      config: {
        relayUrl,
        relayFingerprint: relay.identity.fingerprint,
        role: "worker",
        targetNodeId: controllerIdentity.nodeId,
        enrollmentAdmission: await createEnrollmentAdmission(controllerIdentity),
      },
      identity: dormantIdentity,
    });
    try {
      await dormant.connect();
      await controller.replaceAuthorization([
        workerIdentity.peer,
        dormantIdentity.peer,
      ]);
      const controllerTransport = createMeshRelayPeerTransport(() => controller);
      const requestController = new AbortController();
      const response = controllerTransport.request(
        {
          kind: "relay",
          targetNodeId: dormantIdentity.nodeId,
          relayUrl,
          relayFingerprint: relay.identity.fingerprint,
        },
        "/api/mesh/internal/health",
        {
          method: "POST",
          body: "{}",
          signal: requestController.signal,
        },
      );
      requestController.abort();
      await expect(response).rejects.toMatchObject({
        code: "mesh_relay_request_aborted",
      });
    } finally {
      dormant.close();
      await controller.replaceAuthorization([workerIdentity.peer]);
    }
  });

  test("reports an unreachable peer without masking the caller taxonomy", async () => {
    const unknown: MeshRelayPeerRoute = { ...route(), targetNodeId: "missing-node" };
    let captured: unknown;
    try {
      await transport().request(unknown, "/api/mesh/internal/health", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(MeshRelayStreamError);
    expect(captured).not.toBeInstanceOf(DomainError);
    expect((captured as MeshRelayStreamError).status).toBe(503);
  });

  test("relays a socket stream preserving text and binary frame boundaries", async () => {
    const socket = transport().openSocket(route(), "/api/mesh/internal/terminal", {
      "x-clanky-mesh-session-id": "session",
      "x-clanky-mesh-session-token": "token",
    });
    socket.binaryType = "arraybuffer";
    const received: (string | Uint8Array)[] = [];
    let closeCode = 0;
    socket.addEventListener("message", (event) => {
      received.push(typeof event.data === "string"
        ? event.data
        : new Uint8Array(event.data as ArrayBuffer));
    });
    socket.addEventListener("close", (event) => {
      closeCode = event.code;
    });

    // Sends before the stream opens must be queued, not dropped.
    socket.send("first");
    await pollUntil(
      () => socket.readyState,
      (state) => state === WebSocket.OPEN,
      { description: "the relay socket to open" },
    );
    socket.send(new Uint8Array([1, 2, 3, 4]));
    socket.send("second");

    await pollUntil(
      () => received.length,
      (count) => count === 3,
      { description: "three relayed socket frames" },
    );
    expect(received[0]).toBe("echo:first");
    expect(received[1]).toBeInstanceOf(Uint8Array);
    expect([...(received[1] as Uint8Array)]).toEqual([1, 2, 3, 4]);
    expect(received[2]).toBe("echo:second");

    socket.send("bye");
    await pollUntil(
      () => socket.readyState,
      (state) => state === WebSocket.CLOSED,
      { description: "the relay socket to close" },
    );
    expect(closeCode).toBe(1000);
  });

  test("reconnects after the relay control connection is lost", async () => {
    const reconnectIdentity = createIdentity("worker-reconnect-node");
    const manager = new MeshRelayConnectorManager({
      identity: reconnectIdentity,
      baseDelayMs: 10,
      maxDelayMs: 50,
    });
    try {
      manager.start({
        config: {
          relayUrl,
          relayFingerprint: relay.identity.fingerprint,
          role: "worker",
          targetNodeId: controllerIdentity.nodeId,
          enrollmentAdmission: await createEnrollmentAdmission(controllerIdentity),
        },
        dispatch,
      });
      const first = await manager.waitUntilConnected(10_000);
      expect(first.nodeId).toBe(reconnectIdentity.nodeId);

      relay.broker.closeControl(first.connectionId, 1011, "Forced relay disconnect");

      const reconnected = await pollUntil(
        () => manager.authorization,
        (authorization) => manager.status === "connected"
          && authorization !== undefined
          && authorization.connectionId !== first.connectionId,
        {
          description: "the Mesh relay connection to be re-established",
          timeoutMs: 10_000,
          formatLastObserved: (value) =>
            `${manager.status}/${value?.connectionId ?? "none"}`,
        },
      );
      expect(reconnected?.nodeId).toBe(reconnectIdentity.nodeId);
    } finally {
      await manager.stop();
      expect(manager.status).toBe("idle");
    }
  });

  test("rejects relay work once the control connection is closed", async () => {
    const closingIdentity = createIdentity("worker-closing-node");
    const closing = new MeshRelayConnector({
      config: {
        relayUrl,
        relayFingerprint: relay.identity.fingerprint,
        role: "worker",
        targetNodeId: controllerIdentity.nodeId,
        enrollmentAdmission: await createEnrollmentAdmission(controllerIdentity),
      },
      identity: closingIdentity,
    });
    await closing.connect();
    closing.close(1000, "test teardown");

    await expect(closing.openStream({
      kind: "http",
      method: "POST",
      path: "/api/mesh/internal/enrollment",
      headers: {},
    })).rejects.toMatchObject({ code: "mesh_relay_disconnected" });
  });

  test("rejects an unknown worker without controller-signed admission", async () => {
    const unadmitted = new MeshRelayConnector({
      config: {
        relayUrl,
        relayFingerprint: relay.identity.fingerprint,
        role: "worker",
        targetNodeId: controllerIdentity.nodeId,
      },
      identity: createIdentity("worker-unadmitted-node"),
    });
    await expect(unadmitted.connect()).rejects.toMatchObject({
      code: "mesh_relay_disconnected",
    });
  });

  test("binds each enrollment admission to the first worker identity", async () => {
    const admission = await createEnrollmentAdmission(controllerIdentity);
    const first = new MeshRelayConnector({
      config: {
        relayUrl,
        relayFingerprint: relay.identity.fingerprint,
        role: "worker",
        targetNodeId: controllerIdentity.nodeId,
        enrollmentAdmission: admission,
      },
      identity: createIdentity("worker-admission-first"),
    });
    const second = new MeshRelayConnector({
      config: {
        relayUrl,
        relayFingerprint: relay.identity.fingerprint,
        role: "worker",
        targetNodeId: controllerIdentity.nodeId,
        enrollmentAdmission: admission,
      },
      identity: createIdentity("worker-admission-second"),
    });
    try {
      expect((await first.connect()).workerStatus).toBe("pending");
      await expect(second.connect()).rejects.toMatchObject({
        code: "mesh_relay_disconnected",
      });
    } finally {
      first.close();
      second.close();
    }
  });

  test("refuses a relay that presents an unexpected fingerprint", async () => {
    const untrusting = new MeshRelayConnector({
      config: {
        relayUrl,
        relayFingerprint: `sha256:${"0".repeat(64)}`,
        role: "worker",
        targetNodeId: controllerIdentity.nodeId,
      },
      identity: createIdentity("worker-pinned-node"),
    });
    await expect(untrusting.connect()).rejects.toMatchObject({
      code: "mesh_relay_challenge_invalid",
    });
  });
});
