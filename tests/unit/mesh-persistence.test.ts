import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getControllerGrant,
  getWorkerRegistration,
  listControllerGrants,
  listWorkerRegistrations,
  revokeControllerGrant,
  revokeWorkerRegistration,
  saveControllerGrant,
  saveWorkerRegistration,
} from "../../src/persistence/mesh";
import { closeDatabase, getDatabase, initializeDatabase } from "../../src/persistence/database";
import { DEFAULT_EXECUTION_HOST_CAPABILITIES } from "../../src/shared/execution-host";
import { seedTestOwnerUser } from "../setup";
import {
  ensureExecutionHost,
  getExecutionHostByRef,
  listExecutionHosts,
} from "../../src/persistence/execution-hosts";
import { migrateMeshControllerWorker } from "../../src/persistence/migrations/mesh-controller-worker";

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
  test("stores independent controller grants without a roster", async () => {
    await saveControllerGrant({
      controllerNodeId: "controller-a",
      controllerInstanceName: "Controller A",
      controllerPublicKey: "public-a",
      controllerFingerprint: "fingerprint-a",
      controllerEncryptionPublicKey: null,
    });
    await saveControllerGrant({
      controllerNodeId: "controller-b",
      controllerInstanceName: "Controller B",
      controllerPublicKey: "public-b",
      controllerFingerprint: "fingerprint-b",
      controllerEncryptionPublicKey: null,
    });

    expect((await listControllerGrants()).map((grant) => grant.controllerNodeId)).toEqual([
      "controller-a",
      "controller-b",
    ]);
    await revokeControllerGrant("controller-a");
    expect((await getControllerGrant("controller-a"))?.grantStatus).toBe("revoked");
    expect((await getControllerGrant("controller-b"))?.grantStatus).toBe("active");
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
      workerEncryptionPublicKey: null,
      workerDirectory: "/srv/worker",
      workerCapabilities: DEFAULT_EXECUTION_HOST_CAPABILITIES,
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
      workerEncryptionPublicKey: null,
      workerDirectory: "/srv/worker",
      workerCapabilities: DEFAULT_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 2,
    });
    expect(getExecutionHostByRef("admin", { kind: "mesh", nodeId: "worker-a" })?.revokedAt).toBeNull();
  });

  test("clean break deletes Mesh hosts while preserving local and SSH hosts", () => {
    ensureExecutionHost("admin", { kind: "local", nodeId: "local" }, "local");
    ensureExecutionHost("admin", { kind: "ssh", serverId: "ssh-1" }, "ssh:ssh-1");
    ensureExecutionHost("admin", { kind: "mesh", nodeId: "legacy" }, "mesh:legacy");

    migrateMeshControllerWorker(getDatabase());

    expect(listExecutionHosts("admin").map((host) => host.ref.kind).sort()).toEqual([
      "local",
      "ssh",
    ]);
    const tokenColumns = getDatabase()
      .query("PRAGMA table_info(mesh_enrollment_tokens)")
      .all() as Array<{ name: string }>;
    expect(tokenColumns.map((column) => column.name)).not.toContain("link_id");
    expect(getDatabase().query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
