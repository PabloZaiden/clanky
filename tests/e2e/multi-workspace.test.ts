/**
 * E2E tests for multi-workspace operations.
 * Tests that multiple workspaces can operate with different server configs
 * in parallel without interfering with each other.
 */

import { test, expect, describe, beforeEach, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { serve, type Server } from "bun";
import { apiRoutes } from "../../src/api";
import { ensureDataDirectories } from "../../src/persistence/database";
import { backendManager } from "../../src/core/backend-manager";
import { createMockBackend } from "../mocks/mock-backend";
import { TestCommandExecutor } from "../mocks/mock-executor";

// Default test model for task creation (model is now required)
const testModel = { providerID: "test-provider", modelID: "test-model", variant: "" };
const createTaskRequestBase = {
  attachments: [],
  cheapModel: { mode: "same-as-task" as const },
  maxIterations: null,
  maxConsecutiveErrors: 10,
  activityTimeoutSeconds: 300,
  stopPattern: "<promise>COMPLETE</promise>$",
  git: {
    branchPrefix: "",
    commitScope: "",
  },
  baseBranch: "main",
  clearPlanningFolder: false,
  autoAcceptPlan: false,
  fullyAutonomous: false,
  draft: false,
};

function makeServerSettings(overrides?: {
  mode?: "spawn" | "connect";
  hostname?: string;
  port?: number;
  username?: string;
  password?: string;
}) {
  const mode = overrides?.mode ?? "spawn";
  const isConnect = mode === "connect";
  if (isConnect) {
    return {
      agent: {
        provider: "opencode" as const,
        transport: "ssh" as const,
        hostname: overrides?.hostname ?? "localhost",
        port: overrides?.port ?? 22,
        ...(overrides?.username ? { username: overrides.username } : {}),
        ...(overrides?.password ? { password: overrides.password } : {}),
      },
    };
  }
  return {
    agent: {
      provider: "opencode" as const,
      transport: "stdio" as const,
    },
  };
}

describe("Multi-Workspace E2E", () => {
  let testDataDir: string;
  let testWorkDir1: string;
  let testWorkDir2: string;
  let server: Server<unknown>;
  let baseUrl: string;

  beforeAll(async () => {
    // Create temp directories
    testDataDir = await mkdtemp(join(tmpdir(), "clanky-multi-workspace-test-data-"));
    testWorkDir1 = await mkdtemp(join(tmpdir(), "clanky-multi-workspace-test-work1-"));
    testWorkDir2 = await mkdtemp(join(tmpdir(), "clanky-multi-workspace-test-work2-"));

    // Set env var for persistence before importing modules
    process.env["CLANKY_DATA_DIR"] = testDataDir;

    // Ensure directories exist
    await ensureDataDirectories();

    // Initialize git repos in test work directories
    await Bun.$`git init -b main ${testWorkDir1}`.quiet();
    await Bun.$`git -C ${testWorkDir1} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${testWorkDir1} config user.name "Test User"`.quiet();
    await Bun.$`touch ${testWorkDir1}/README.md`.quiet();
    await Bun.$`git -C ${testWorkDir1} add .`.quiet();
    await Bun.$`git -C ${testWorkDir1} commit -m "Initial commit"`.quiet();

    await Bun.$`git init -b main ${testWorkDir2}`.quiet();
    await Bun.$`git -C ${testWorkDir2} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${testWorkDir2} config user.name "Test User"`.quiet();
    await Bun.$`touch ${testWorkDir2}/README.md`.quiet();
    await Bun.$`git -C ${testWorkDir2} add .`.quiet();
    await Bun.$`git -C ${testWorkDir2} commit -m "Initial commit"`.quiet();

    // Set up backend manager with test executor factory
    backendManager.setBackendForTesting(createMockBackend());
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    // Start test server on random port
    server = serve({
      port: 0, // Random available port
      routes: {
        ...apiRoutes,
      },
    });
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    // Stop server
    server.stop();

    // Reset backend manager
    backendManager.resetForTesting();

    // Cleanup temp directories
    await rm(testDataDir, { recursive: true, force: true });
    await rm(testWorkDir1, { recursive: true, force: true });
    await rm(testWorkDir2, { recursive: true, force: true });

    // Clear env
    delete process.env["CLANKY_DATA_DIR"];
  });

  // Clean up workspaces before each test
  beforeEach(async () => {
    const { getDatabase } = await import("../../src/persistence/database");
    // Clear the workspaces and tasks tables
    const db = getDatabase();
    db.run("DELETE FROM tasks WHERE workspace_id IS NOT NULL");
    db.run("DELETE FROM workspaces");
  });

  describe("Multiple workspaces with different server settings", () => {
    test("creates two workspaces with different server settings", async () => {
      // Create workspace 1 with spawn mode
      const ws1Response = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Workspace 1 - Spawn",
          directory: testWorkDir1,
          serverSettings: makeServerSettings({ mode: "spawn" }),
        }),
      });
      expect(ws1Response.ok).toBe(true);
      const ws1 = await ws1Response.json();

      // Create workspace 2 with connect mode
      const ws2Response = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Workspace 2 - Connect",
          directory: testWorkDir2,
          serverSettings: makeServerSettings({
            mode: "connect",
            hostname: "example-server.com",
            port: 8080,
          }),
        }),
      });
      expect(ws2Response.ok).toBe(true);
      const ws2 = await ws2Response.json();

      // Verify both workspaces exist with correct settings
      const listResponse = await fetch(`${baseUrl}/api/workspaces`);
      expect(listResponse.ok).toBe(true);
      const workspaces = await listResponse.json();

      expect(workspaces.length).toBe(2);

      // Verify workspace 1 settings
      const fetchedWs1 = workspaces.find((w: { id: string }) => w.id === ws1.id);
      expect(fetchedWs1.serverSettings.agent.transport).toBe("stdio");

      // Verify workspace 2 settings
      const fetchedWs2 = workspaces.find((w: { id: string }) => w.id === ws2.id);
      expect(fetchedWs2.serverSettings.agent.transport).toBe("ssh");
      expect(fetchedWs2.serverSettings.agent.hostname).toBe("example-server.com");
      expect(fetchedWs2.serverSettings.agent.port).toBe(8080);
    });

    test("updating one workspace settings does not affect another", async () => {
      // Create two workspaces with identical settings
      const ws1Response = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Workspace 1",
          directory: testWorkDir1,
          serverSettings: makeServerSettings({ mode: "spawn" }),
        }),
      });
      const ws1 = await ws1Response.json();

      const ws2Response = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Workspace 2",
          directory: testWorkDir2,
          serverSettings: makeServerSettings({ mode: "spawn" }),
        }),
      });
      const ws2 = await ws2Response.json();

      // Update workspace 1 settings
      const updateResponse = await fetch(`${baseUrl}/api/workspaces/${ws1.id}/server-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          makeServerSettings({
            mode: "connect",
            hostname: "new-server.com",
            port: 9000,
          })
        ),
      });
      expect(updateResponse.ok).toBe(true);

      // Verify workspace 1 was updated
      const ws1GetResponse = await fetch(`${baseUrl}/api/workspaces/${ws1.id}/server-settings`);
      const ws1Settings = await ws1GetResponse.json();
      expect(ws1Settings.agent.transport).toBe("ssh");
      expect(ws1Settings.agent.hostname).toBe("new-server.com");

      // Verify workspace 2 was NOT affected
      const ws2GetResponse = await fetch(`${baseUrl}/api/workspaces/${ws2.id}/server-settings`);
      const ws2Settings = await ws2GetResponse.json();
      expect(ws2Settings.agent.transport).toBe("stdio");
      expect(ws2Settings.agent.hostname).toBeUndefined();
    });

    test("tasks are isolated to their workspace", async () => {
      // Create two workspaces
      const ws1Response = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Workspace 1",
          directory: testWorkDir1,
          serverSettings: makeServerSettings({ mode: "spawn" }),
        }),
      });
      const ws1 = await ws1Response.json();

      const ws2Response = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Workspace 2",
          directory: testWorkDir2,
          serverSettings: makeServerSettings({ mode: "spawn" }),
        }),
      });
      const ws2 = await ws2Response.json();

      // Create a task in workspace 1
      const task1Response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...createTaskRequestBase,
          workspaceId: ws1.id,
          prompt: "Test task for workspace 1",
          name: "Test Draft Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(task1Response.ok).toBe(true);
      const task1 = await task1Response.json();

      // Create a task in workspace 2
      const task2Response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...createTaskRequestBase,
          workspaceId: ws2.id,
          prompt: "Test task for workspace 2",
          name: "Test Draft Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(task2Response.ok).toBe(true);
      const task2 = await task2Response.json();

      // Verify tasks are in different workspaces
      expect(task1.config.workspaceId).toBe(ws1.id);
      expect(task2.config.workspaceId).toBe(ws2.id);

      // Verify tasks use correct directories
      expect(task1.config.directory).toBe(testWorkDir1);
      expect(task2.config.directory).toBe(testWorkDir2);

    });

    test("deleting one workspace does not affect another", async () => {
      // Create two workspaces
      const ws1Response = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Workspace 1",
          directory: testWorkDir1,
          serverSettings: { agent: { provider: "opencode", transport: "stdio" } },
        }),
      });
      const ws1 = await ws1Response.json();

      const ws2Response = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Workspace 2",
          directory: testWorkDir2,
          serverSettings: { agent: { provider: "opencode", transport: "stdio" } },
        }),
      });
      const ws2 = await ws2Response.json();

      // Delete workspace 1
      const deleteResponse = await fetch(`${baseUrl}/api/workspaces/${ws1.id}`, {
        method: "DELETE",
      });
      expect(deleteResponse.ok).toBe(true);

      // Verify workspace 1 is gone
      const ws1GetResponse = await fetch(`${baseUrl}/api/workspaces/${ws1.id}`);
      expect(ws1GetResponse.status).toBe(404);

      // Verify workspace 2 still exists
      const ws2GetResponse = await fetch(`${baseUrl}/api/workspaces/${ws2.id}`);
      expect(ws2GetResponse.ok).toBe(true);
      const ws2Fetched = await ws2GetResponse.json();
      expect(ws2Fetched.name).toBe("Workspace 2");
    });
  });

  describe("Connection status isolation", () => {
    test("each workspace has independent connection status", async () => {
      // Create two workspaces with different modes
      const ws1Response = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Workspace 1 - Spawn",
          directory: testWorkDir1,
          serverSettings: makeServerSettings({ mode: "spawn" }),
        }),
      });
      const ws1 = await ws1Response.json();

      const ws2Response = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Workspace 2 - Connect",
          directory: testWorkDir2,
          serverSettings: makeServerSettings({
            mode: "connect",
            hostname: "example.com",
            port: 8080,
          }),
        }),
      });
      const ws2 = await ws2Response.json();

      // Get connection status for each workspace
      const status1Response = await fetch(`${baseUrl}/api/workspaces/${ws1.id}/server-settings/status`);
      expect(status1Response.ok).toBe(true);
      const status1 = await status1Response.json();

      const status2Response = await fetch(`${baseUrl}/api/workspaces/${ws2.id}/server-settings/status`);
      expect(status2Response.ok).toBe(true);
      const status2 = await status2Response.json();

      // Both should have independent status
      expect(status1).toHaveProperty("connected");
      expect(status1).toHaveProperty("provider");
      expect(status1).toHaveProperty("transport");
      expect(status2).toHaveProperty("connected");
      expect(status2).toHaveProperty("provider");
      expect(status2).toHaveProperty("transport");
    });
  });
});
