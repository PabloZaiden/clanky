import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase, initializeDatabase } from "../../src/persistence/database";
import { createWorkspace, getWorkspace } from "../../src/persistence/workspaces";
import { applyMeshCheckpoint, parseMeshWorkspacePayload } from "../../src/core/mesh-sync-service";
import {
  createMeshLink,
  mergeMeshLinkMember,
  saveMeshNode,
} from "../../src/persistence/mesh";
import {
  ensureLocalMeshNodeIdentity,
  getMeshNodeFingerprint,
} from "../../src/persistence/mesh-node-identity";
import { isMeshAggregateEligible } from "../../src/persistence/mesh-sync";
import { runWithCurrentUser } from "../../src/core/user-context";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "clanky-mesh-eligibility-"));
  closeDatabase();
  process.env["CLANKY_DATA_DIR"] = dataDir;
  await initializeDatabase();
  const now = new Date().toISOString();
  getDatabase().run(`
    INSERT INTO webapp_users (
      id, username, role, auth_version, created_at, updated_at,
      last_login_at, disabled_at
    ) VALUES ('local-user', 'local-user', 'user', 1, ?, ?, NULL, NULL)
  `, [now, now]);
});

afterEach(async () => {
  closeDatabase();
  delete process.env["CLANKY_DATA_DIR"];
  await rm(dataDir, { recursive: true, force: true });
});

describe("mesh sync eligibility and workspace parsing", () => {
  test("allows stdio workspace descriptors", async () => {
    const workspace = {
      id: crypto.randomUUID(),
      name: "Local stdio workspace",
      directory: "/local/workspace",
      serverSettings: {
        agent: {
          provider: "opencode" as const,
          transport: "stdio" as const,
        },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await runWithCurrentUser(
      { id: "local-user", username: "local-user", role: "user", isOwner: false, isAdmin: false },
      () => createWorkspace(workspace),
    );

    expect(isMeshAggregateEligible("local-user", "workspace", workspace.id)).toBe(true);

    const now = new Date().toISOString();
    const taskId = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    getDatabase().run(`
      INSERT INTO tasks (
        id, user_id, name, directory, prompt, created_at, updated_at,
        stop_pattern, git_branch_prefix, workspace_id
      ) VALUES (?, 'local-user', 'Task', ?, 'Prompt', ?, ?, 'done', 'task', ?)
    `, [taskId, workspace.directory, now, now, workspace.id]);
    getDatabase().run(`
      INSERT INTO chats (
        id, user_id, name, source_kind, workspace_id, scope, directory, created_at, updated_at
      ) VALUES (?, 'local-user', 'Chat', 'workspace', ?, 'workspace', ?, ?, ?)
    `, [chatId, workspace.id, workspace.directory, now, now]);
    getDatabase().run(`
      INSERT INTO agents (
        id, user_id, name, workspace_id, directory, prompt,
        model_provider_id, model_model_id, schedule_start_at_local,
        schedule_timezone, schedule_interval_value, schedule_interval_unit,
        schedule_next_run_at, created_at, updated_at, status
      ) VALUES (?, 'local-user', 'Agent', ?, ?, 'Prompt', 'opencode', 'test-model',
        ?, 'UTC', 1, 'day', ?, ?, ?, 'idle')
    `, [agentId, workspace.id, workspace.directory, now, now, now, now]);

    expect(isMeshAggregateEligible("local-user", "task", taskId)).toBe(false);
    expect(isMeshAggregateEligible("local-user", "chat", chatId)).toBe(false);
    expect(isMeshAggregateEligible("local-user", "agent", agentId)).toBe(false);
  });

  test("preserves validated stdio ownership metadata and rejects SSH fields", async () => {
    const workspace = {
      id: crypto.randomUUID(),
      name: "Local stdio workspace",
      directory: "/local/workspace",
      serverSettings: {
        agent: {
          provider: "opencode" as const,
          transport: "stdio" as const,
        },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      executionNodeId: "origin-node",
    };
    const parsed = await parseMeshWorkspacePayload({
      workspace,
      identityFile: { configured: false },
    });
    expect(parsed.workspace).toMatchObject({
      id: workspace.id,
      executionNodeId: "origin-node",
      serverSettings: workspace.serverSettings,
    });

    await expect(parseMeshWorkspacePayload({
      ...workspace,
      serverSettings: {
        agent: {
          provider: "opencode",
          transport: "stdio",
          hostname: "should-not-be-present",
        },
      },
    })).rejects.toThrow("stdio settings contain SSH fields");

    await expect(parseMeshWorkspacePayload({
      workspace,
      identityFile: { configured: true },
    })).rejects.toThrow("cannot configure an identity file");
  });

  test("preserves stdio physical ownership across authority-origin changes", async () => {
    const localIdentity = await ensureLocalMeshNodeIdentity();
    const remoteSigningKeys = generateKeyPairSync("ed25519");
    const remotePublicKey = remoteSigningKeys.publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    const remoteNodeId = crypto.randomUUID();
    const remoteFingerprint = getMeshNodeFingerprint(remotePublicKey);
    await saveMeshNode({
      nodeId: remoteNodeId,
      publicKey: remotePublicKey,
      fingerprint: remoteFingerprint,
      endpoint: "http://remote.example.test",
      transport: "http",
      status: "active",
    });
    const link = await createMeshLink({
      localUserId: "local-user",
      localNodeId: localIdentity.nodeId,
      localNodeEndpoint: "http://local.example.test",
      localNodeTransport: "http",
    });
    await mergeMeshLinkMember({
      linkId: link.linkId,
      nodeId: remoteNodeId,
      localUserId: "remote-user",
      endpoint: "http://remote.example.test",
      transport: "http",
      status: "active",
      membershipGeneration: 1,
      publicKey: remotePublicKey,
      fingerprint: remoteFingerprint,
    });

    const workspaceId = crypto.randomUUID();
    await applyMeshCheckpoint(remoteNodeId, {
      checkpointId: crypto.randomUUID(),
      linkId: link.linkId,
      aggregateType: "workspace",
      aggregateId: workspaceId,
      originNodeId: remoteNodeId,
      baseRevision: 0,
      targetRevision: 1,
      basePayload: null,
      payload: {
        id: workspaceId,
        name: "Legacy stdio workspace",
        directory: "/remote/workspace",
        serverSettings: {
          agent: {
            provider: "opencode",
            transport: "stdio",
          },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        executionNodeId: "physical-owner-node",
      },
      tombstone: false,
      createdAt: new Date().toISOString(),
    });

    expect(await runWithCurrentUser(
      { id: "local-user", username: "local-user", role: "user", isOwner: false, isAdmin: false },
      async () => (await getWorkspace(workspaceId))?.executionNodeId,
    )).toBe("physical-owner-node");
  });
});
