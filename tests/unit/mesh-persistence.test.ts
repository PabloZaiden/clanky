import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteRevokedWorkerRegistration,
  getControllerGrant,
  getWorkerRegistration,
  InconsistentMeshControllerRelayGrantError,
  listControllerGrants,
  listWorkerRegistrations,
  revokeControllerGrant,
  revokeWorkerRegistration,
  saveControllerGrant,
  saveWorkerRegistration,
  updateWorkerHealthSnapshot,
} from "../../src/persistence/mesh";
import {
  InconsistentMeshWorkerIdentityError,
  listActiveControllerWorkerIdentities,
} from "../../src/persistence/controller-relay-pairing";
import { closeDatabase, getDatabase, initializeDatabase } from "../../src/persistence/database";
import { InvalidMeshRelayRouteError } from "../../src/persistence/errors";
import { POSIX_EXECUTION_HOST_CAPABILITIES } from "../../src/shared/execution-host";
import { seedTestOwnerUser } from "../setup";
import {
  ensureExecutionHost,
  getExecutionHostByRef,
} from "../../src/persistence/execution-hosts";
import {
  ensureLocalMeshNodeIdentity,
  getMeshNodeFingerprint,
} from "../../src/persistence/mesh-node-identity";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "clanky-worker-grants-"));
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

describe("controller-worker Mesh persistence", () => {
  // Upgrade boundary: an identity file from before encryption keys were
  // persisted must rotate cleanly instead of preventing server startup.
  test("rotates a stale local identity before strict encryption validation", async () => {
    const previousIdentity = await ensureLocalMeshNodeIdentity();
    const identityPath = join(dataDir, "mesh", "node-identity.json");
    const storedIdentity = JSON.parse(await Bun.file(identityPath).text()) as Record<string, unknown>;
    delete storedIdentity["encryptionPublicKey"];
    delete storedIdentity["encryptionPrivateKey"];
    await Bun.write(identityPath, JSON.stringify(storedIdentity));
    getDatabase().query("DELETE FROM mesh_node_identity").run();

    const rotatedIdentity = await ensureLocalMeshNodeIdentity();
    expect(rotatedIdentity.nodeId).not.toBe(previousIdentity.nodeId);
    expect(typeof rotatedIdentity.encryptionPublicKey).toBe("string");

    const persistedIdentity = JSON.parse(await Bun.file(identityPath).text()) as Record<string, unknown>;
    expect(typeof persistedIdentity["encryptionPublicKey"]).toBe("string");
    expect(typeof persistedIdentity["encryptionPrivateKey"]).toBe("string");
    expect(
      (getDatabase().query(
        "SELECT encryption_public_key FROM mesh_node_identity WHERE singleton = 1",
      ).get() as { encryption_public_key: string }).encryption_public_key,
    ).toBe(rotatedIdentity.encryptionPublicKey);
  });

  test("unions exact active worker identities across owners and rejects conflicts", async () => {
    const now = new Date().toISOString();
    getDatabase().query(`
      INSERT INTO webapp_users (
        id, username, role, auth_version, created_at, updated_at
      ) VALUES ('owner-2', 'owner-2', 'owner', 1, ?, ?)
    `).run(now, now);
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    const relayRoute = {
      relayUrl: "https://relay.example",
      relayFingerprint: "relay-fingerprint",
    };
    const base = {
      workerNodeId: "worker-shared",
      workerInstanceName: "Shared worker",
      workerEndpoint: "https://worker.example",
      workerTransport: "https" as const,
      workerPublicKey: publicKey,
      workerFingerprint: getMeshNodeFingerprint(publicKey),
      workerEncryptionPublicKey: "test-encryption-key",
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/srv/worker",
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
      route: {
        kind: "relay" as const,
        targetNodeId: "worker-shared",
        ...relayRoute,
      },
    };
    await saveWorkerRegistration({ ...base, localUserId: "admin" });
    await saveWorkerRegistration({
      ...base,
      localUserId: "owner-2",
      route: {
        kind: "direct",
        endpoint: "http://worker.example",
        transport: "http",
        tlsTrust: "none",
        tlsCertificate: null,
        tlsFingerprint: null,
      },
    });
    const directKeys = generateKeyPairSync("ed25519");
    const directPublicKey = directKeys.publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    await saveWorkerRegistration({
      ...base,
      workerNodeId: "worker-direct",
      localUserId: "admin",
      workerPublicKey: directPublicKey,
      workerFingerprint: getMeshNodeFingerprint(directPublicKey),
      route: {
        kind: "direct",
        endpoint: "http://worker.example",
        transport: "http",
        tlsTrust: "none",
        tlsCertificate: null,
        tlsFingerprint: null,
      },
    });
    expect(listActiveControllerWorkerIdentities(relayRoute)).toEqual([{
      nodeId: base.workerNodeId,
      publicKey: base.workerPublicKey,
      fingerprint: base.workerFingerprint,
    }]);

    await expect(saveWorkerRegistration({
      ...base,
      localUserId: "owner-2",
      workerPublicKey: "different-public",
      workerFingerprint: "different-fingerprint",
    })).rejects.toBeInstanceOf(InconsistentMeshWorkerIdentityError);

    // Simulate corrupt storage to retain fail-closed snapshot coverage.
    getDatabase().query(`
      UPDATE mesh_worker_registrations
      SET worker_public_key = 'different-public',
        worker_fingerprint = 'different-fingerprint'
      WHERE local_user_id = 'owner-2' AND worker_node_id = 'worker-shared'
    `).run();
    expect(() => listActiveControllerWorkerIdentities(relayRoute))
      .toThrow(InconsistentMeshWorkerIdentityError);
  });

  test("stores independent controller grants without a roster", async () => {
    await saveControllerGrant({
      controllerNodeId: "controller-a",
      controllerInstanceName: "Controller A",
      controllerPublicKey: "public-a",
      controllerFingerprint: "fingerprint-a",
      controllerEncryptionPublicKey: "test-encryption-key",
    });
    await saveControllerGrant({
      controllerNodeId: "controller-b",
      controllerInstanceName: "Controller B",
      controllerPublicKey: "public-b",
      controllerFingerprint: "fingerprint-b",
      controllerEncryptionPublicKey: "test-encryption-key",
    });

    expect((await listControllerGrants()).map((grant) => grant.controllerNodeId)).toEqual([
      "controller-a",
      "controller-b",
    ]);
    await revokeControllerGrant("controller-a");
    expect((await getControllerGrant("controller-a"))?.grantStatus).toBe("revoked");
    expect((await getControllerGrant("controller-b"))?.grantStatus).toBe("active");
  });

  test("atomically rejects a second active relay controller grant", async () => {
    const relayRoute = {
      kind: "relay" as const,
      relayUrl: "https://relay.example",
      relayFingerprint: "relay-fingerprint",
    };
    await saveControllerGrant({
      controllerNodeId: "controller-relay-a",
      controllerInstanceName: "Controller A",
      controllerPublicKey: "public-a",
      controllerFingerprint: "fingerprint-a",
      controllerEncryptionPublicKey: "test-encryption-key",
      controllerRoute: {
        ...relayRoute,
        targetNodeId: "controller-relay-a",
      },
    });

    await expect(saveControllerGrant({
      controllerNodeId: "controller-relay-b",
      controllerInstanceName: "Controller B",
      controllerPublicKey: "public-b",
      controllerFingerprint: "fingerprint-b",
      controllerEncryptionPublicKey: "test-encryption-key",
      controllerRoute: {
        ...relayRoute,
        targetNodeId: "controller-relay-b",
      },
    })).rejects.toBeInstanceOf(InconsistentMeshControllerRelayGrantError);
    expect((await listControllerGrants()).map((grant) => grant.controllerNodeId))
      .toEqual(["controller-relay-a"]);
  });

  // Corrupt persisted route metadata is a data-safety boundary: it must never
  // reinterpret a relay endpoint as a directly reachable peer.
  test("fails closed for incomplete persisted relay routes", async () => {
    const relayRoute = {
      kind: "relay" as const,
      relayUrl: "https://relay.example",
      relayFingerprint: "relay-fingerprint",
    };
    await saveWorkerRegistration({
      workerNodeId: "worker-corrupt-route",
      localUserId: "admin",
      workerInstanceName: "Corrupt route worker",
      workerEndpoint: relayRoute.relayUrl,
      workerTransport: "https",
      workerPublicKey: "worker-public",
      workerFingerprint: "worker-fingerprint",
      workerEncryptionPublicKey: "test-encryption-key",
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/srv/worker",
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
      route: {
        ...relayRoute,
        targetNodeId: "worker-corrupt-route",
      },
    });
    getDatabase().query(`
      UPDATE mesh_worker_registrations
      SET relay_fingerprint = NULL
      WHERE worker_node_id = 'worker-corrupt-route'
    `).run();
    expect(() => getWorkerRegistration("worker-corrupt-route", "admin"))
      .toThrow(InvalidMeshRelayRouteError);
    expect(await listWorkerRegistrations("admin")).toEqual([]);
    expect(() => listActiveControllerWorkerIdentities({
      relayUrl: relayRoute.relayUrl,
      relayFingerprint: relayRoute.relayFingerprint,
    })).toThrow(InvalidMeshRelayRouteError);
    await revokeWorkerRegistration("worker-corrupt-route", "admin");
    expect(
      getDatabase().query(`
        SELECT grant_status
        FROM mesh_worker_registrations
        WHERE worker_node_id = 'worker-corrupt-route'
      `).get(),
    ).toEqual({ grant_status: "revoked" });
    await deleteRevokedWorkerRegistration("worker-corrupt-route", "admin");
    expect(getWorkerRegistration("worker-corrupt-route", "admin")).toBeNull();

    await saveControllerGrant({
      controllerNodeId: "controller-corrupt-route",
      controllerInstanceName: "Corrupt route controller",
      controllerPublicKey: "controller-public",
      controllerFingerprint: "controller-fingerprint",
      controllerEncryptionPublicKey: "test-encryption-key",
      controllerRoute: {
        ...relayRoute,
        targetNodeId: "controller-corrupt-route",
      },
    });
    getDatabase().query(`
      UPDATE mesh_controller_grants
      SET relay_url = NULL
      WHERE controller_node_id = 'controller-corrupt-route'
    `).run();
    await expect(getControllerGrant("controller-corrupt-route"))
      .rejects.toBeInstanceOf(InvalidMeshRelayRouteError);
  });

  test("scopes worker registrations and revocation to their owner", async () => {
    await saveWorkerRegistration({
      workerNodeId: "worker-a",
      localUserId: "admin",
      workerInstanceName: "Worker A",
      workerEndpoint: "https://worker.example",
      workerTransport: "https",
      workerPublicKey: "public",
      workerFingerprint: "fingerprint",
      workerEncryptionPublicKey: "test-encryption-key",
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/srv/worker",
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
    });

    expect((await listWorkerRegistrations("admin"))).toHaveLength(1);
    expect(await getWorkerRegistration("worker-a", "other-user")).toBeNull();
    await revokeWorkerRegistration("worker-a", "admin");
    expect((await getWorkerRegistration("worker-a", "admin"))?.grantStatus).toBe("revoked");

    await saveWorkerRegistration({
      workerNodeId: "worker-a",
      localUserId: "admin",
      workerInstanceName: "Worker A",
      workerEndpoint: "https://worker.example",
      workerTransport: "https",
      workerPublicKey: "public",
      workerFingerprint: "fingerprint",
      workerEncryptionPublicKey: "test-encryption-key",
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/srv/worker",
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 2,
    });
    expect(getExecutionHostByRef("admin", { kind: "mesh", nodeId: "worker-a" })?.revokedAt).toBeNull();
  });

  // This persistence-boundary contract protects capability downgrades without
  // invalidating bindings whose execution target did not change.
  test("updates a worker runtime snapshot without advancing the host binding", async () => {
    await saveWorkerRegistration({
      workerNodeId: "worker-runtime",
      localUserId: "admin",
      workerInstanceName: "Runtime worker",
      workerEndpoint: "https://worker.example",
      workerTransport: "https",
      workerPublicKey: "runtime-public",
      workerFingerprint: "runtime-fingerprint",
      workerEncryptionPublicKey: "test-encryption-key",
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/srv/worker",
      workerPlatform: { os: "linux", architecture: "x64" },
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
    });
    const ref = { kind: "mesh" as const, nodeId: "worker-runtime" };
    const initialHost = getExecutionHostByRef("admin", ref)!;

    await updateWorkerHealthSnapshot({
      workerNodeId: "worker-runtime",
      localUserId: "admin",
      directory: "C:\\workspaces",
      platform: { os: "windows", architecture: "x64" },
      capabilities: { serverHealth: 1 },
      acceptRemoteExecution: true,
      configRevision: 1,
    });

    expect(await getWorkerRegistration("worker-runtime", "admin")).toMatchObject({
      workerDirectory: "C:\\workspaces",
      workerPlatform: { os: "windows", architecture: "x64" },
      workerCapabilities: { serverHealth: 1 },
    });
    expect(getExecutionHostByRef("admin", ref)).toMatchObject({
      revision: initialHost.revision,
      runtime: {
        platform: { os: "windows", architecture: "x64" },
        capabilities: { serverHealth: 1 },
      },
    });
  });

  // Runtime capabilities are an authorization boundary. A failed canonical
  // host write must roll back the registration snapshot from the same health
  // update so readers cannot observe different capability grants.
  test("rolls back the worker registration when the canonical snapshot update fails", async () => {
    await saveWorkerRegistration({
      workerNodeId: "worker-runtime-rollback",
      localUserId: "admin",
      workerInstanceName: "Runtime rollback worker",
      workerEndpoint: "https://worker.example",
      workerTransport: "https",
      workerPublicKey: "runtime-rollback-public",
      workerFingerprint: "runtime-rollback-fingerprint",
      workerEncryptionPublicKey: "test-encryption-key",
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/srv/worker",
      workerPlatform: { os: "linux", architecture: "x64" },
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
    });
    const ref = {
      kind: "mesh" as const,
      nodeId: "worker-runtime-rollback",
    };
    getDatabase().run(`
      CREATE TRIGGER fail_runtime_snapshot_update
      BEFORE UPDATE OF capabilities_json ON execution_hosts
      WHEN OLD.source_id = 'worker-runtime-rollback'
      BEGIN
        SELECT RAISE(ABORT, 'forced canonical snapshot failure');
      END
    `);

    await expect(updateWorkerHealthSnapshot({
      workerNodeId: "worker-runtime-rollback",
      localUserId: "admin",
      directory: "C:\\workspaces",
      platform: { os: "windows", architecture: "x64" },
      capabilities: { serverHealth: 1 },
      acceptRemoteExecution: true,
      configRevision: 2,
    })).rejects.toThrow("forced canonical snapshot failure");

    expect(await getWorkerRegistration(
      "worker-runtime-rollback",
      "admin",
    )).toMatchObject({
      workerDirectory: "/srv/worker",
      workerPlatform: { os: "linux", architecture: "x64" },
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerConfigRevision: 1,
    });
    expect(getExecutionHostByRef("admin", ref)?.runtime).toEqual({
      platform: { os: "linux", architecture: "x64" },
      capabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
    });
  });

  // This persistence-boundary contract prevents partially trusted runtime
  // metadata from enabling operations after storage corruption.
  test("fails closed when either half of a runtime snapshot is corrupt", async () => {
    const canonicalRef = { kind: "mesh" as const, nodeId: "canonical-corrupt-runtime" };
    ensureExecutionHost("admin", canonicalRef, "mesh:canonical-corrupt-runtime", {
      runtime: {
        platform: { os: "linux", architecture: "x64" },
        capabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      },
    });
    getDatabase().query(`
      UPDATE execution_hosts
      SET capabilities_json = '{invalid'
      WHERE user_id = 'admin' AND source_id = 'canonical-corrupt-runtime'
    `).run();
    expect(getExecutionHostByRef("admin", canonicalRef)?.runtime).toEqual({
      platform: null,
      capabilities: {},
    });

    await saveWorkerRegistration({
      workerNodeId: "worker-corrupt-runtime",
      localUserId: "admin",
      workerInstanceName: "Corrupt runtime worker",
      workerEndpoint: "https://worker.example",
      workerTransport: "https",
      workerPublicKey: "corrupt-runtime-public",
      workerFingerprint: "corrupt-runtime-fingerprint",
      workerEncryptionPublicKey: "test-encryption-key",
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/srv/worker",
      workerPlatform: { os: "linux", architecture: "x64" },
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
    });
    getDatabase().query(`
      UPDATE mesh_worker_registrations
      SET worker_platform_os = 'unsupported'
      WHERE local_user_id = 'admin' AND worker_node_id = 'worker-corrupt-runtime'
    `).run();
    expect(await getWorkerRegistration("worker-corrupt-runtime", "admin")).toMatchObject({
      workerPlatform: null,
      workerCapabilities: {},
    });
  });

});
