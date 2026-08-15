import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createInitialState } from "@/shared/task";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import type { Task, Workspace } from "@/shared";
import { bootstrapMeshPeer } from "../../src/core/mesh-sync-bootstrap";
import { runWithCurrentUser } from "../../src/core/user-context";
import {
  createMeshLink,
} from "../../src/persistence/mesh";
import {
  ensureLocalMeshNodeIdentity,
} from "../../src/persistence/mesh-node-identity";
import { closeDatabase, getDatabase, initializeDatabase } from "../../src/persistence/database";
import { createWorkspace } from "../../src/persistence/workspaces";
import {
  saveTask,
  updateTaskStateForUser,
} from "../../src/persistence/tasks";
import { pollUntil } from "../helpers/polling";

const testUser: CurrentUser = {
  id: "mesh-task-user",
  username: "mesh-task-user",
  role: "user",
  isOwner: false,
  isAdmin: false,
};

let dataDir: string;

function getLatestTaskCheckpoint(taskId: string): Task | null {
  const row = getDatabase().query(`
    SELECT payload
    FROM mesh_sync_checkpoints
    WHERE aggregate_type = 'task' AND aggregate_id = ?
    ORDER BY target_revision DESC
    LIMIT 1
  `).get(taskId) as { payload: string | null } | null;
  return row?.payload ? JSON.parse(row.payload) as Task : null;
}

function createTestTask(workspace: Workspace): Task {
  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();
  return {
    config: {
      id: taskId,
      name: "Mesh task",
      directory: workspace.directory,
      prompt: "Test mesh task",
      createdAt: now,
      updatedAt: now,
      workspaceId: workspace.id,
      model: {
        providerID: "opencode",
        modelID: "test-model",
        variant: "",
      },
      cheapModel: { mode: "same-as-task" },
      maxIterations: 10,
      maxConsecutiveErrors: 3,
      activityTimeoutSeconds: null,
      stopPattern: "<promise>COMPLETE</promise>$",
      git: {
        branchPrefix: "",
        commitScope: "",
      },
      useWorktree: true,
      clearPlanningFolder: false,
      planMode: true,
      autoAcceptPlan: true,
      fullyAutonomous: false,
      mode: "task",
    },
    state: {
      ...createInitialState(taskId),
      status: "draft",
    },
  };
}

async function createLinkedWorkspace(): Promise<Workspace> {
  const workspace: Workspace = {
    id: crypto.randomUUID(),
    name: "Mesh workspace",
    directory: "/mesh/workspace",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    serverSettings: {
      agent: {
        provider: "opencode",
        transport: "ssh",
        hostname: "mesh-host",
      },
    },
  };
  await runWithCurrentUser(testUser, () => createWorkspace(workspace));
  const identity = await ensureLocalMeshNodeIdentity();
  await createMeshLink({
    localUserId: testUser.id,
    localNodeId: identity.nodeId,
    localNodeEndpoint: "http://local.mesh.test",
    localNodeTransport: "http",
  });
  return workspace;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "clanky-mesh-task-sync-"));
  closeDatabase();
  process.env["CLANKY_DATA_DIR"] = dataDir;
  await initializeDatabase();
  const now = new Date().toISOString();
  getDatabase().run(`
    INSERT INTO webapp_users (
      id, username, role, auth_version, created_at, updated_at,
      last_login_at, disabled_at
    ) VALUES (?, ?, 'user', 1, ?, ?, NULL, NULL)
  `, [testUser.id, testUser.username, now, now]);
});

afterEach(async () => {
  closeDatabase();
  delete process.env["CLANKY_DATA_DIR"];
  await rm(dataDir, { recursive: true, force: true });
});

describe("mesh task synchronization", () => {
  test("resnapshots the current task state for a linked user", async () => {
    const workspace = await createLinkedWorkspace();
    const task = createTestTask(workspace);
    await runWithCurrentUser(testUser, () => saveTask(task));

    await bootstrapMeshPeer(testUser);
    expect(getLatestTaskCheckpoint(task.config.id)?.state.status).toBe("draft");

    getDatabase().run(
      "UPDATE tasks SET status = 'merged' WHERE id = ? AND user_id = ?",
      [task.config.id, testUser.id],
    );
    await bootstrapMeshPeer(testUser);

    expect(getLatestTaskCheckpoint(task.config.id)?.state.status).toBe("merged");
  });

  test("publishes task state updates as mesh checkpoints", async () => {
    const workspace = await createLinkedWorkspace();
    const task = createTestTask(workspace);
    await runWithCurrentUser(testUser, () => saveTask(task));

    const completedState = {
      ...task.state,
      status: "completed" as const,
      completedAt: new Date().toISOString(),
    };
    await updateTaskStateForUser(task.config.id, completedState, testUser.id);

    await pollUntil(
      () => getLatestTaskCheckpoint(task.config.id),
      (checkpoint) => checkpoint?.state.status === "completed",
      {
        description: "task state mesh checkpoint",
        formatLastObserved: (checkpoint) => checkpoint?.state.status ?? "missing",
      },
    );
  });
});
