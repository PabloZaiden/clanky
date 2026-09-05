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
