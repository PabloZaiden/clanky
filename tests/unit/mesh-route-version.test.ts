/**
 * Mesh routes are usable only when every active hop supports a common generation.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initializeDatabase } from "../../src/persistence/database";
import { saveWorkerRegistration } from "../../src/persistence/mesh";
import { saveControllerRelayPairing } from "../../src/persistence/controller-relay-pairing";
import { getMeshNodeFingerprint } from "../../src/persistence/mesh-node-identity";
import { meshWorkerRouteVersion } from "../../src/core/mesh-route-version";
import { discoverMeshWorkerGeneration } from "../../src/core/mesh-worker-generation";
import {
  MESH_PROTOCOL_VERSION,
  negotiateMeshProtocolGeneration,
  type MeshProtocolGeneration,
  type MeshProtocolVersion,
} from "../../src/shared/mesh-protocol";
import { seedTestOwnerUser } from "../setup";
import { serveNativeApiRoutes } from "../native-api-server";
import type { ExecutionHostDescriptor } from "../../src/shared/execution-host";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "clanky-mesh-route-version-"));
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

async function pairedWorker(
  negotiated: MeshProtocolVersion | null,
  supportedProtocolVersions: readonly MeshProtocolGeneration[] = [MESH_PROTOCOL_VERSION],
) {
  const publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString();
  const pairing = saveControllerRelayPairing({
    name: "mesh-relay", relayUrl: "https://relay.example", relayPublicKey: publicKey,
    relayFingerprint: getMeshNodeFingerprint(publicKey), controllerNodeId: "controller", controllerFingerprint: "controller-fingerprint",
    relaySupportedProtocolVersions: [MESH_PROTOCOL_VERSION], relayPreferredProtocolVersion: MESH_PROTOCOL_VERSION,
    relayNegotiatedProtocolVersion: negotiated,
  });
  // Invalid persisted metadata must not infer a negotiated hop from capabilities.
  if (negotiated === null) getDatabase().query(
    "UPDATE mesh_controller_relays SET relay_negotiated_protocol_version = 0 WHERE name = ?",
  ).run(pairing.name);
  return await saveWorkerRegistration({
    workerNodeId: "worker", workerInstanceName: "Worker", localUserId: "admin",
    workerEndpoint: "https://worker.example", workerTransport: "https", workerPublicKey: publicKey,
    workerFingerprint: getMeshNodeFingerprint(publicKey), workerEncryptionPublicKey: "fixture-encryption",
    workerTlsCertificate: null, workerTlsFingerprint: null, workerDirectory: "/workspace",
    workerCapabilities: {}, workerAcceptRemoteExecution: true, workerConfigRevision: 1,
    workerSupportedProtocolVersions: supportedProtocolVersions,
    route: { kind: "relay", relayUrl: pairing.relayUrl, relayFingerprint: pairing.relayFingerprint, targetNodeId: "worker" },
  });
}

test("Mesh execution targets expose native adapters through relay workers", async () => {
  await pairedWorker(MESH_PROTOCOL_VERSION);
  const server = serveNativeApiRoutes();
  try {
    const response = await fetch(new URL("/api/workspaces/execution-targets", server.url));
    expect(response.status).toBe(200);
    const hosts = await response.json() as ExecutionHostDescriptor[];
    expect(hosts.find((host) => host.ref.kind === "mesh")?.harnessAdapters).toEqual([
      "acp",
      "copilot",
      "codex",
      "opencode2",
    ]);
  } finally {
    await server.stop(true);
  }
});

test("Mesh route and discovery fail closed without a negotiated relay hop", async () => {
  const worker = await pairedWorker(null);
  expect(() => meshWorkerRouteVersion(worker)).toThrow(expect.objectContaining({ code: "mesh_execution_protocol_mismatch" }));
  await expect(discoverMeshWorkerGeneration(worker)).rejects.toMatchObject({ code: "mesh_execution_protocol_mismatch" });
  const server = serveNativeApiRoutes();
  try {
    const response = await fetch(new URL("/api/execution-hosts", server.url));
    expect(response.status).toBe(200);
    const hosts = await response.json() as ExecutionHostDescriptor[];
    expect(hosts.find((host) => host.ref.kind === "mesh")).toMatchObject({
      harnessAdapters: [], harnessAdapterError: "mesh_execution_protocol_mismatch",
    });
    expect(hosts.find((host) => host.ref.kind === "local")?.harnessAdapters).toEqual(["acp", "copilot", "codex", "opencode2"]);
  } finally {
    await server.stop(true);
  }
});

test("Mesh route negotiation accepts extra peer capabilities and rejects disjoint lists", async () => {
  const extraGeneration = MESH_PROTOCOL_VERSION + 1;
  const worker = await pairedWorker(
    MESH_PROTOCOL_VERSION,
    [extraGeneration, MESH_PROTOCOL_VERSION],
  );
  expect(worker.workerSupportedProtocolVersions).toEqual([
    extraGeneration,
    MESH_PROTOCOL_VERSION,
  ]);
  expect(meshWorkerRouteVersion(worker)).toBe(MESH_PROTOCOL_VERSION);
  expect(() => meshWorkerRouteVersion({ ...worker, workerSupportedProtocolVersions: [] })).toThrow(
    expect.objectContaining({ code: "mesh_execution_protocol_mismatch" }),
  );
  expect(() => meshWorkerRouteVersion({
    ...worker,
    workerSupportedProtocolVersions: [extraGeneration],
  })).toThrow(expect.objectContaining({ code: "mesh_execution_protocol_mismatch" }));
});

// The current build implements one local generation, so synthetic capability
// sets preserve coverage of generic highest-common selection.
test("Mesh generation negotiation chooses the highest common capability regardless of order", () => {
  expect(negotiateMeshProtocolGeneration([3, 11, 8, 11], [8, 11, 4])).toBe(11);
  expect(negotiateMeshProtocolGeneration([3, 8], [9, 12])).toBeNull();
});
