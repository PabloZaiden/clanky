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
  listExecutionHosts,
} from "../../src/persistence/execution-hosts";
import { migrateMeshControllerWorker } from "../../src/persistence/migrations/mesh-controller-worker";
import { getMeshNodeFingerprint } from "../../src/persistence/mesh-node-identity";

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
      workerEncryptionPublicKey: null,
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

    // Simulate legacy/corrupt storage to retain fail-closed snapshot coverage.
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
      controllerEncryptionPublicKey: null,
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
      controllerEncryptionPublicKey: null,
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
      workerEncryptionPublicKey: null,
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
      controllerEncryptionPublicKey: null,
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
      workerEncryptionPublicKey: null,
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
      workerEncryptionPublicKey: null,
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
      workerEncryptionPublicKey: null,
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
      capabilities: { commandExecution: 1, serverHealth: 1 },
      acceptRemoteExecution: true,
      configRevision: 1,
    });

    expect(await getWorkerRegistration("worker-runtime", "admin")).toMatchObject({
      workerDirectory: "C:\\workspaces",
      workerPlatform: { os: "windows", architecture: "x64" },
      workerCapabilities: { commandExecution: 1, serverHealth: 1 },
    });
    expect(getExecutionHostByRef("admin", ref)).toMatchObject({
      revision: initialHost.revision,
      runtime: {
        platform: { os: "windows", architecture: "x64" },
        capabilities: { commandExecution: 1, serverHealth: 1 },
      },
    });
  });

  // Migration coverage is kept at the persistence boundary because a partial
  // cleanup can leave foreign keys valid while retaining unusable legacy data.
  test("clean break deletes the complete legacy Mesh dependency graph", () => {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.run("ALTER TABLE workspaces ADD COLUMN execution_node_id TEXT");
    db.run("ALTER TABLE workspaces ADD COLUMN server_fingerprint TEXT");
    db.run("ALTER TABLE terminal_sessions ADD COLUMN target_transport TEXT");
    db.run("ALTER TABLE terminal_sessions ADD COLUMN target_key TEXT");
    db.run("ALTER TABLE terminal_sessions ADD COLUMN target_execution_node_id TEXT");
    db.run(
      `INSERT INTO mesh_node_identity (
        singleton, node_id, public_key, fingerprint, created_at, updated_at
      ) VALUES (1, 'legacy-local', 'public', 'fingerprint', ?, ?)`,
      [now, now],
    );
    db.run("CREATE TABLE mesh_nodes (node_id TEXT PRIMARY KEY)");
    db.run("INSERT INTO mesh_nodes(node_id) VALUES ('legacy-worker')");
    const localHost = ensureExecutionHost(
      "admin",
      { kind: "local", nodeId: "legacy-local" },
      "local",
    );
    const sshHost = ensureExecutionHost(
      "admin",
      { kind: "ssh", serverId: "ssh-1" },
      "ssh:ssh-1",
    );
    const meshHost = ensureExecutionHost(
      "admin",
      { kind: "mesh", nodeId: "legacy-worker" },
      "mesh:legacy-worker",
    );
    for (const [id, executionNodeId, executionHostId] of [
      ["local-workspace", "legacy-local", localHost.id],
      ["mesh-workspace", "legacy-worker", meshHost.id],
      ["orphan-mesh-workspace", "legacy-worker", meshHost.id],
      ["ssh-workspace", null, sshHost.id],
    ] as const) {
      db.run(
        `INSERT INTO workspaces (
          id, user_id, name, directory, execution_node_id,
          server_fingerprint, created_at, updated_at,
          execution_host_id, execution_host_revision
        ) VALUES (?, 'admin', ?, '/tmp', ?, 'fingerprint', ?, ?, ?, 1)`,
        [id, id, executionNodeId, now, now, executionHostId],
      );
    }
    for (const [id, workspaceId] of [
      ["local-task", "local-workspace"],
      ["mesh-task", "mesh-workspace"],
    ] as const) {
      db.run(
        `INSERT INTO tasks (
          id, user_id, name, directory, prompt, created_at, updated_at,
          stop_pattern, git_branch_prefix, workspace_id
        ) VALUES (?, 'admin', ?, '/tmp', 'prompt', ?, ?, 'DONE', 'clanky/', ?)`,
        [id, id, now, now, workspaceId],
      );
      db.run(
        `INSERT INTO sessions (
          backend_name, task_id, session_id, created_at
        ) VALUES ('copilot', ?, ?, ?)`,
        [id, `${id}-session`, now],
      );
      db.run(
        `INSERT INTO review_comments (
          id, user_id, task_id, review_cycle, comment_text, created_at
        ) VALUES (?, 'admin', ?, 1, 'comment', ?)`,
        [`${id}-comment`, id, now],
      );
    }
    db.run(
      `INSERT INTO chats (
        id, user_id, name, source_kind, scope, directory, created_at,
        updated_at, execution_host_id, execution_host_revision
      ) VALUES (
        'mesh-chat', 'admin', 'Mesh chat', 'execution_host',
        'execution_host', '/tmp', ?, ?, ?, 1
      )`,
      [now, now, meshHost.id],
    );
    db.run(
      `INSERT INTO agents (
        id, user_id, name, workspace_id, directory, prompt,
        model_provider_id, model_model_id, schedule_start_at_local,
        schedule_timezone, schedule_interval_value, schedule_interval_unit,
        schedule_next_run_at, enabled, mode, created_at, updated_at, status,
        generation_chat_id
      ) VALUES (
        'mesh-agent', 'admin', 'Mesh agent', 'ssh-workspace', '/tmp', 'prompt',
        'copilot', 'model', ?, 'UTC', 1, 'days', ?, 1, 'agent', ?, ?, 'idle',
        'mesh-chat'
      )`,
      [now, now, now, now],
    );
    db.run(
      `INSERT INTO agent_runs (
        id, user_id, agent_id, chat_id, status, trigger, scheduled_for,
        config_snapshot, created_at, updated_at
      ) VALUES (
        'mesh-agent-run', 'admin', 'mesh-agent', 'mesh-chat', 'completed',
        'manual', ?, '{}', ?, ?
      )`,
      [now, now, now],
    );
    db.run(
      `INSERT INTO clanky_context_api_keys (
        user_id, workspace_id, context_type, context_id, api_key_id,
        generation, created_at
      ) VALUES (
        'admin', 'mesh-workspace', 'workspace', 'mesh-workspace',
        'mesh-api-key', 1, ?
      )`,
      [now],
    );
    db.run(
      `INSERT INTO terminal_sessions (
        id, user_id, name, directory, remote_session_name, created_at,
        updated_at, target_transport, target_key, target_execution_node_id,
        execution_host_id, execution_host_revision
      ) VALUES (
        'mesh-terminal', 'admin', 'Mesh terminal', '/tmp', 'mesh-terminal',
        ?, ?, 'mesh', 'mesh:legacy-worker', 'legacy-worker', ?, 1
      )`,
      [now, now, meshHost.id],
    );
    db.run(
      `INSERT INTO provisioning_jobs (
        id, user_id, workspace_id, config_json, state_json, status,
        created_at, updated_at, execution_host_id, execution_host_revision
      ) VALUES (
        'mesh-workspace-provisioning', 'admin', 'orphan-mesh-workspace',
        '{}', '{}', 'failed', ?, ?, ?, 1
      )`,
      [now, now, meshHost.id],
    );
    db.run(
      `INSERT INTO provisioning_jobs (
        id, user_id, config_json, state_json, status, created_at, updated_at,
        execution_host_id, execution_host_revision
      ) VALUES (
        'mesh-provisioning', 'admin', '{}', '{}', 'failed', ?, ?, ?, 1
      )`,
      [now, now, meshHost.id],
    );
    db.run(
      `INSERT INTO vnc_sessions (
        id, user_id, remote_port, local_port, created_at, updated_at, status,
        execution_host_id, execution_host_revision
      ) VALUES ('mesh-vnc', 'admin', 5900, 15900, ?, ?, 'stopped', ?, 1)`,
      [now, now, meshHost.id],
    );

    migrateMeshControllerWorker(db);

    expect(listExecutionHosts("admin").map((host) => host.ref.kind).sort()).toEqual([
      "ssh",
    ]);
    expect(
      (db.query("SELECT id FROM workspaces ORDER BY id").all() as Array<{ id: string }>)
        .map((row) => row.id),
    ).toEqual(["ssh-workspace"]);
    for (const table of [
      "tasks",
      "sessions",
      "review_comments",
      "chats",
      "agents",
      "agent_runs",
      "clanky_context_api_keys",
      "terminal_sessions",
      "provisioning_jobs",
      "vnc_sessions",
    ]) {
      expect((db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      }).count).toBe(0);
    }
    const tokenColumns = db
      .query("PRAGMA table_info(mesh_enrollment_tokens)")
      .all() as Array<{ name: string }>;
    expect(tokenColumns.map((column) => column.name)).not.toContain("link_id");
    expect(db.query("SELECT * FROM mesh_node_identity").all()).toEqual([]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
