/**
 * Protocol negotiation boundary for persisted active relay hops.
 * Normal cluster handshakes select v6; they cannot exercise a deliberately
 * lower or missing negotiated hop while the peer still advertises both.
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
import { seedTestOwnerUser } from "../setup";

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

async function pairedWorker(negotiated: 5 | 6 | null) {
  const publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString();
  const pairing = saveControllerRelayPairing({
    name: "dual-generation", relayUrl: "https://relay.example", relayPublicKey: publicKey,
    relayFingerprint: getMeshNodeFingerprint(publicKey), controllerNodeId: "controller", controllerFingerprint: "controller-fingerprint",
    relaySupportedProtocolVersions: [6, 5], relayPreferredProtocolVersion: 6,
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
    workerSupportedProtocolVersions: [6, 5],
    route: { kind: "relay", relayUrl: pairing.relayUrl, relayFingerprint: pairing.relayFingerprint, targetNodeId: "worker" },
  });
}

test("Mesh route stays on the negotiated v5 relay hop despite advertised v6", async () => {
  const worker = await pairedWorker(5);
  expect(meshWorkerRouteVersion(worker)).toBe(5);
});

test("Mesh discovery stays on the negotiated v5 relay hop despite advertised v6", async () => {
  const worker = await pairedWorker(5);
  await expect(discoverMeshWorkerGeneration(worker)).resolves.toBe(5);
});

test("Mesh route and discovery fail closed without a negotiated relay hop", async () => {
  const worker = await pairedWorker(null);
  expect(() => meshWorkerRouteVersion(worker)).toThrow(expect.objectContaining({ code: "mesh_execution_protocol_mismatch" }));
  await expect(discoverMeshWorkerGeneration(worker)).rejects.toMatchObject({ code: "mesh_execution_protocol_mismatch" });
});

test("Mesh v6 relay routes preserve legacy worker ACP and mutually supported native generations", async () => {
  const worker = await pairedWorker(6);
  expect(meshWorkerRouteVersion(worker)).toBe(6);
  expect(meshWorkerRouteVersion({ ...worker, workerSupportedProtocolVersions: [5] })).toBe(5);
  expect(() => meshWorkerRouteVersion({ ...worker, workerSupportedProtocolVersions: [] })).toThrow(
    expect.objectContaining({ code: "mesh_execution_protocol_mismatch" }),
  );
});
