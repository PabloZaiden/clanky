/**
 * Unit tests for workspace persistence layer.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { access, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import type { Workspace } from "../../src/types/workspace";
import { getDefaultServerSettings } from "../../src/types/settings";
import { DEFAULT_TASK_CONFIG } from "../../src/types/task";

// We need to set the env var before importing the module
let testDataDir: string;

/**
 * Helper function to create a test workspace with all required fields.
 */
function createTestWorkspace(overrides: {
  id?: string;
  name?: string;
  directory?: string;
}): Workspace {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? randomUUID(),
    name: overrides.name ?? "Test Workspace",
    directory: overrides.directory ?? "/tmp/test-project",
    createdAt: now,
    updatedAt: now,
    serverSettings: getDefaultServerSettings(),
  };
}

function createConnectServerSettings(overrides?: {
  hostname?: string;
  port?: number;
  username?: string;
  password?: string;
}) {
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("Workspace Persistence", () => {
  beforeEach(async () => {
    // Create a temp directory for each test
    testDataDir = await mkdtemp(join(tmpdir(), "clanky-workspace-test-"));
    process.env["CLANKY_DATA_DIR"] = testDataDir;
  });

  afterEach(async () => {
    // Close the database before cleaning up
    const { closeDatabase } = await import("../../src/persistence/database");
    closeDatabase();

    // Clean up
    delete process.env["CLANKY_DATA_DIR"];
    await rm(testDataDir, { recursive: true, force: true });
  });

  describe("CRUD operations", () => {
    test("createWorkspace creates a new workspace", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { createWorkspace, getWorkspace } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const workspace = createTestWorkspace({
        name: "Test Workspace",
        directory: "/tmp/test-project",
      });

      await createWorkspace(workspace);

      // Verify it was persisted
      const loaded = await getWorkspace(workspace.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(workspace.id);
      expect(loaded!.name).toBe("Test Workspace");
      expect(loaded!.directory).toBe("/tmp/test-project");
      expect(loaded!.createdAt).toBeDefined();
      expect(loaded!.updatedAt).toBeDefined();
    });

    test("getWorkspace returns null for non-existent workspace", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { getWorkspace } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const workspace = await getWorkspace("non-existent-id");
      expect(workspace).toBeNull();
    });

    test("listWorkspaces returns all workspaces sorted by name alphabetically", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { createWorkspace, listWorkspaces } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      // Create workspaces with different names (out of alphabetical order)
      const ws1 = createTestWorkspace({ name: "Zeta Workspace", directory: "/tmp/zeta" });
      await createWorkspace(ws1);

      const ws2 = createTestWorkspace({ name: "Alpha Workspace", directory: "/tmp/alpha" });
      await createWorkspace(ws2);

      const ws3 = createTestWorkspace({ name: "beta workspace", directory: "/tmp/beta" });
      await createWorkspace(ws3);

      const workspaces = await listWorkspaces();
      expect(workspaces.length).toBe(3);
      // Should be sorted alphabetically by name (case-insensitive)
      expect(workspaces[0]!.name).toBe("Alpha Workspace");
      expect(workspaces[1]!.name).toBe("beta workspace");
      expect(workspaces[2]!.name).toBe("Zeta Workspace");
    });

    test("updateWorkspace updates workspace name", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { createWorkspace, updateWorkspace, getWorkspace } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const workspace = createTestWorkspace({
        name: "Original Name",
        directory: "/tmp/update-test",
      });
      await createWorkspace(workspace);

      const updated = await updateWorkspace(workspace.id, { name: "New Name" });
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("New Name");
      expect(updated!.directory).toBe("/tmp/update-test");

      // Verify persisted
      const loaded = await getWorkspace(workspace.id);
      expect(loaded!.name).toBe("New Name");
    });

    test("updateWorkspace returns null for non-existent workspace", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { updateWorkspace } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const result = await updateWorkspace("non-existent", { name: "New Name" });
      expect(result).toBeNull();
    });

    test("deleteWorkspace removes workspace", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { createWorkspace, deleteWorkspace, getWorkspace, listWorkspaces } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const workspace = createTestWorkspace({
        name: "Delete Me",
        directory: "/tmp/delete-test",
      });
      await createWorkspace(workspace);

      expect(await getWorkspace(workspace.id)).not.toBeNull();

      const result = await deleteWorkspace(workspace.id);
      expect(result.success).toBe(true);

      expect(await getWorkspace(workspace.id)).toBeNull();
      expect(await listWorkspaces()).toHaveLength(0);
    });

    test("deleteWorkspace returns failure for non-existent workspace", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { deleteWorkspace } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const result = await deleteWorkspace("non-existent");
      expect(result.success).toBe(false);
      expect(result.reason).toBe("Workspace not found");
    });
  });

  describe("listWorkspacesByDirectory", () => {
    test("returns the matching workspace when directory matches", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { createWorkspace, listWorkspacesByDirectory } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const workspace = createTestWorkspace({
        name: "My Project",
        directory: "/home/user/projects/my-project",
      });
      await createWorkspace(workspace);

      const found = await listWorkspacesByDirectory("/home/user/projects/my-project");
      expect(found).toHaveLength(1);
      expect(found[0]!.name).toBe("My Project");
    });

    test("returns an empty array when no workspace has the directory", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { createWorkspace, listWorkspacesByDirectory } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const workspace = createTestWorkspace({
        name: "Other Project",
        directory: "/home/user/other-project",
      });
      await createWorkspace(workspace);

      const found = await listWorkspacesByDirectory("/home/user/different-project");
      expect(found).toEqual([]);
    });

    test("allows duplicate directories on different server targets", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { createWorkspace, listWorkspacesByDirectory } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const ws1 = createTestWorkspace({
        name: "Local Workspace",
        directory: "/tmp/shared-dir",
      });
      await createWorkspace(ws1);

      const sshSettings = createConnectServerSettings({
        hostname: "remote.example",
        port: 2222,
      });
      const ws2 = createTestWorkspace({
        name: "Remote Workspace",
        directory: "/tmp/shared-dir",
      });
      ws2.serverSettings = sshSettings;
      await createWorkspace(ws2);

      const matches = await listWorkspacesByDirectory("/tmp/shared-dir");
      expect(matches).toHaveLength(2);
      expect(matches.some((workspace) => workspace.id === ws2.id)).toBe(true);
    });

    test("allows duplicate directories with same server fingerprint (identified by ID)", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const {
        createWorkspace,
        getWorkspace,
        listWorkspacesByDirectory,
        listWorkspaces,
      } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      // Two workspaces with identical directory and default (stdio) server settings
      const ws1 = createTestWorkspace({
        name: "Container 1",
        directory: "/workspaces/myrepo",
      });
      await createWorkspace(ws1);

      const ws2 = createTestWorkspace({
        name: "Container 2",
        directory: "/workspaces/myrepo",
      });
      await createWorkspace(ws2);

      // Both should exist with different IDs
      expect(ws1.id).not.toBe(ws2.id);

      const fetched1 = await getWorkspace(ws1.id);
      const fetched2 = await getWorkspace(ws2.id);
      expect(fetched1).not.toBeNull();
      expect(fetched2).not.toBeNull();
      expect(fetched1!.name).toBe("Container 1");
      expect(fetched2!.name).toBe("Container 2");

      // Directory-based lookup returns both
      const matches = await listWorkspacesByDirectory("/workspaces/myrepo");
      expect(matches).toHaveLength(2);

      // Both appear in the full workspace list
      const all = await listWorkspaces();
      const ids = all.map((w) => w.id);
      expect(ids).toContain(ws1.id);
      expect(ids).toContain(ws2.id);
    });
  });

  describe("touchWorkspace", () => {
    test("updates updatedAt timestamp", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { createWorkspace, touchWorkspace, getWorkspace } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const workspace = createTestWorkspace({
        name: "Touch Test",
        directory: "/tmp/touch-test",
      });
      workspace.updatedAt = "2024-01-01T00:00:00Z";
      await createWorkspace(workspace);

      const original = await getWorkspace(workspace.id);
      const originalUpdatedAt = original!.updatedAt;

      await touchWorkspace(workspace.id);

      const updated = await getWorkspace(workspace.id);
      expect(updated!.updatedAt).not.toBe(originalUpdatedAt);
    });
  });

  describe("getWorkspaceTaskCount", () => {
    test("returns 0 when workspace has no tasks", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { createWorkspace, getWorkspaceTaskCount } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const workspace = createTestWorkspace({
        name: "Empty Workspace",
        directory: "/tmp/empty-workspace",
      });
      await createWorkspace(workspace);

      const count = await getWorkspaceTaskCount(workspace.id);
      expect(count).toBe(0);
    });

    test("returns correct count when workspace has tasks", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { createWorkspace, getWorkspaceTaskCount } = await import("../../src/persistence/workspaces");
      const { saveTask } = await import("../../src/persistence/tasks");

      await ensureDataDirectories();

      const workspace = createTestWorkspace({
        name: "Workspace With Tasks",
        directory: "/tmp/workspace-with-tasks",
      });
      await createWorkspace(workspace);

      // Create tasks with this workspace_id
      const now = new Date().toISOString();
      for (let i = 0; i < 3; i++) {
        await saveTask({
          config: {
            id: `task-${i}`,
            name: `Task ${i}`,
            directory: workspace.directory,
            prompt: "Test",
            createdAt: now,
            updatedAt: now,
            model: { providerID: "test-provider", modelID: "test-model", variant: "" },
            stopPattern: "<promise>COMPLETE</promise>$",
            git: { branchPrefix: "", commitScope: "" },
            maxIterations: Infinity,
            maxConsecutiveErrors: 10,
            activityTimeoutSeconds: DEFAULT_TASK_CONFIG.activityTimeoutSeconds,
            useWorktree: DEFAULT_TASK_CONFIG.useWorktree,
            clearPlanningFolder: false,
            planMode: false,
            mode: "task",
            workspaceId: workspace.id,
          },
          state: {
            id: `task-${i}`,
            status: "idle",
            currentIteration: 0,
            recentIterations: [],
            logs: [],
            messages: [],
            toolCalls: [],
          },
        });
      }

      const count = await getWorkspaceTaskCount(workspace.id);
      expect(count).toBe(3);
    });

    test("deleteWorkspace fails when workspace has tasks", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { createWorkspace, deleteWorkspace, getWorkspace } = await import("../../src/persistence/workspaces");
      const { saveTask } = await import("../../src/persistence/tasks");

      await ensureDataDirectories();

      const workspace = createTestWorkspace({
        name: "Workspace With Tasks",
        directory: "/tmp/ws-with-tasks",
      });
      await createWorkspace(workspace);

      // Create a task with this workspace_id
      const now = new Date().toISOString();
      await saveTask({
        config: {
          id: "task-1",
          name: "Task 1",
          directory: workspace.directory,
          prompt: "Test",
          createdAt: now,
          updatedAt: now,
          model: { providerID: "test-provider", modelID: "test-model", variant: "" },
          stopPattern: "<promise>COMPLETE</promise>$",
          git: { branchPrefix: "", commitScope: "" },
          maxIterations: Infinity,
          maxConsecutiveErrors: 10,
          activityTimeoutSeconds: DEFAULT_TASK_CONFIG.activityTimeoutSeconds,
          useWorktree: DEFAULT_TASK_CONFIG.useWorktree,
          clearPlanningFolder: false,
          planMode: false,
          mode: "task",
          workspaceId: workspace.id,
        },
        state: {
          id: "task-1",
          status: "idle",
          currentIteration: 0,
          recentIterations: [],
          logs: [],
          messages: [],
          toolCalls: [],
        },
      });

      // Attempt to delete should fail
      const result = await deleteWorkspace(workspace.id);
      expect(result.success).toBe(false);
      expect(result.reason).toContain("1 task");

      // Workspace should still exist
      expect(await getWorkspace(workspace.id)).not.toBeNull();
    });
  });

  describe("Server Settings Operations", () => {
    test("createWorkspace stores server settings", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { createWorkspace, getWorkspace } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const customSettings = createConnectServerSettings({
        hostname: "custom.server.com",
        port: 9000,
      });

      const workspace = createTestWorkspace({
        name: "Custom Settings Workspace",
        directory: "/tmp/custom-settings",
      });
      workspace.serverSettings = customSettings;
      await createWorkspace(workspace);

      const loaded = await getWorkspace(workspace.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.serverSettings).toEqual(customSettings);
    });

    test("updateWorkspace updates server settings", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { createWorkspace, updateWorkspace, getWorkspace } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const workspace = createTestWorkspace({
        name: "Update Settings Test",
        directory: "/tmp/update-settings",
      });
      await createWorkspace(workspace);

      const newSettings = createConnectServerSettings({
        hostname: "updated.server.com",
        port: 8080,
      });

      const updated = await updateWorkspace(workspace.id, { serverSettings: newSettings });
      expect(updated).not.toBeNull();
      expect(updated!.serverSettings).toEqual(newSettings);

      // Verify persisted
      const loaded = await getWorkspace(workspace.id);
      expect(loaded!.serverSettings).toEqual(newSettings);
    });

    test("updateWorkspace preserves server settings when only updating name", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { createWorkspace, updateWorkspace, getWorkspace } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const customSettings = createConnectServerSettings({
        hostname: "preserved.server.com",
        port: 7000,
      });

      const workspace = createTestWorkspace({
        name: "Original Name",
        directory: "/tmp/preserve-settings",
      });
      workspace.serverSettings = customSettings;
      await createWorkspace(workspace);

      // Update only name
      const updated = await updateWorkspace(workspace.id, { name: "New Name" });
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("New Name");
      expect(updated!.serverSettings).toEqual(customSettings);

      // Verify persisted
      const loaded = await getWorkspace(workspace.id);
      expect(loaded!.name).toBe("New Name");
      expect(loaded!.serverSettings).toEqual(customSettings);
    });

    test("listWorkspaces includes server settings", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { createWorkspace, listWorkspaces } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const customSettings = createConnectServerSettings({
        hostname: "list.server.com",
        port: 6000,
      });

      const workspace = createTestWorkspace({
        name: "List Settings Test",
        directory: "/tmp/list-settings",
      });
      workspace.serverSettings = customSettings;
      await createWorkspace(workspace);

      const workspaces = await listWorkspaces();
      expect(workspaces.length).toBe(1);
      expect(workspaces[0]!.serverSettings).toEqual(customSettings);
    });

    test("listWorkspacesByDirectory includes server settings", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { createWorkspace, listWorkspacesByDirectory } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const customSettings = createConnectServerSettings({
        hostname: "directory.server.com",
        port: 5000,
      });

      const workspace = createTestWorkspace({
        name: "Directory Settings Test",
        directory: "/tmp/directory-settings",
      });
      workspace.serverSettings = customSettings;
      await createWorkspace(workspace);

      const found = await listWorkspacesByDirectory("/tmp/directory-settings");
      expect(found).toHaveLength(1);
      expect(found[0]!.serverSettings).toEqual(customSettings);
    });

    test("legacy experimental transports fall back to stdio", async () => {
      const { ensureDataDirectories, getDatabase } = await import("../../src/persistence/database");
      const { getWorkspace, listWorkspacesByDirectory } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const db = getDatabase();
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO workspaces (id, name, directory, server_fingerprint, server_settings, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          "Legacy Transport Workspace",
          "/tmp/legacy-transport",
          "opencode:stdio",
          JSON.stringify({
            agent: {
              provider: "opencode",
              transport: "ssh-stdio",
              hostname: "legacy-host",
              port: 2222,
            },
          }),
          now,
          now,
        ],
      );

      const workspaces = await listWorkspacesByDirectory("/tmp/legacy-transport");
      expect(workspaces).toHaveLength(1);
      const workspace = workspaces[0]!;
      expect(workspace.serverSettings.agent.transport).toBe("stdio");

      const loadedById = await getWorkspace(workspace.id);
      expect(loadedById).not.toBeNull();
      expect(loadedById!.serverSettings.agent.transport).toBe("stdio");
    });
  });

  describe("Export/Import operations", () => {
    test("export with zero workspaces returns empty array with version 1 and exportedAt", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { exportWorkspaces } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const result = await exportWorkspaces();
      expect(result.version).toBe(1);
      expect(result.exportedAt).toBeDefined();
      expect(result.workspaces).toEqual([]);
      // Verify exportedAt is a valid, normalized ISO timestamp
      expect(Number.isNaN(Date.parse(result.exportedAt))).toBe(false);
      expect(new Date(result.exportedAt).toISOString()).toBe(result.exportedAt);
    });

    test("export with multiple workspaces returns all configs without id/timestamps", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { createWorkspace, exportWorkspaces } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const ws1 = createTestWorkspace({ name: "Alpha", directory: "/tmp/alpha" });
      const ws2 = createTestWorkspace({ name: "Beta", directory: "/tmp/beta" });
      await createWorkspace(ws1);
      await createWorkspace(ws2);

      const result = await exportWorkspaces();
      expect(result.version).toBe(1);
      expect(result.workspaces).toHaveLength(2);

      // Should be sorted alphabetically
      expect(result.workspaces[0]!.name).toBe("Alpha");
      expect(result.workspaces[1]!.name).toBe("Beta");

      // Each config should have name, directory, serverSettings but NOT id/timestamps
      for (const config of result.workspaces) {
        expect(config.name).toBeDefined();
        expect(config.directory).toBeDefined();
        expect(config.serverSettings).toBeDefined();
        // Should NOT have internal fields
        expect((config as Record<string, unknown>)["id"]).toBeUndefined();
        expect((config as Record<string, unknown>)["createdAt"]).toBeUndefined();
        expect((config as Record<string, unknown>)["updatedAt"]).toBeUndefined();
      }
    });

    test("export includes password in serverSettings", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { createWorkspace, exportWorkspaces } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const ws = createTestWorkspace({ name: "With Password", directory: "/tmp/password-test" });
      ws.serverSettings = createConnectServerSettings({
        hostname: "secure.server.com",
        port: 443,
        password: "my-secret-password",
      });
      await createWorkspace(ws);

      const result = await exportWorkspaces();
      expect(result.workspaces).toHaveLength(1);
      const exportedSettings = result.workspaces[0]!.serverSettings;
      expect(exportedSettings.agent.transport).toBe("ssh");
      if (exportedSettings.agent.transport === "ssh") {
        expect(exportedSettings.agent.password).toBe("my-secret-password");
      }
    });

    test("import with valid data creates workspaces and returns correct result", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { importWorkspaces, listWorkspaces } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const importData = {
        version: 1 as const,
        exportedAt: new Date().toISOString(),
        workspaces: [
          {
            name: "Imported WS 1",
            directory: "/tmp/imported-1",
            serverSettings: getDefaultServerSettings(),
          },
          {
            name: "Imported WS 2",
            directory: "/tmp/imported-2",
            serverSettings: createConnectServerSettings({
              hostname: "remote.server.com",
              port: 8080,
            }),
          },
        ],
      };

      const result = await importWorkspaces(importData);
      expect(result.created).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.details).toHaveLength(2);
      expect(result.details[0]!.status).toBe("created");
      expect(result.details[1]!.status).toBe("created");

      // Verify workspaces were actually persisted
      const workspaces = await listWorkspaces();
      expect(workspaces).toHaveLength(2);
    });

    test("import creates all workspaces regardless of directory matches", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { createWorkspace, importWorkspaces, listWorkspaces } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      // Pre-create a workspace
      const existing = createTestWorkspace({ name: "Existing", directory: "/tmp/existing-dir" });
      await createWorkspace(existing);

      const importData = {
        version: 1 as const,
        exportedAt: new Date().toISOString(),
        workspaces: [
          {
            name: "New Workspace",
            directory: "/tmp/new-dir",
            serverSettings: getDefaultServerSettings(),
          },
          {
            name: "Same Dir Same Server",
            directory: "/tmp/existing-dir",
            serverSettings: getDefaultServerSettings(),
          },
          {
            name: "Same Dir Different Server",
            directory: "/tmp/existing-dir",
            serverSettings: createConnectServerSettings({
              hostname: "remote.example",
              port: 2200,
            }),
          },
        ],
      };

      const result = await importWorkspaces(importData);
      // All workspaces are created — no dedup by directory
      expect(result.created).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.details).toHaveLength(3);

      const createdDetails = result.details.filter((d) => d.status === "created");
      expect(createdDetails).toHaveLength(3);

      // Verify total workspaces exist (1 pre-existing + 3 imported)
      const workspaces = await listWorkspaces();
      expect(workspaces).toHaveLength(4);
    });

    test("import with empty workspaces array succeeds (no-op)", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { importWorkspaces } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const importData = {
        version: 1 as const,
        exportedAt: new Date().toISOString(),
        workspaces: [],
      };

      const result = await importWorkspaces(importData);
      expect(result.created).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.details).toEqual([]);
    });

    test("import is not idempotent — re-importing creates additional workspaces", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { importWorkspaces, listWorkspaces } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const importData = {
        version: 1 as const,
        exportedAt: new Date().toISOString(),
        workspaces: [
          {
            name: "Idempotent WS",
            directory: "/tmp/idempotent",
            serverSettings: getDefaultServerSettings(),
          },
        ],
      };

      // First import
      const result1 = await importWorkspaces(importData);
      expect(result1.created).toBe(1);
      expect(result1.skipped).toBe(0);
      expect(result1.failed).toBe(0);

      // Second import — creates another workspace (no dedup by directory)
      const result2 = await importWorkspaces(importData);
      expect(result2.created).toBe(1);
      expect(result2.skipped).toBe(0);
      expect(result2.failed).toBe(0);

      // Should have 2 workspaces now
      const workspaces = await listWorkspaces();
      expect(workspaces).toHaveLength(2);
    });

    test("import preserves serverSettings including password", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { importWorkspaces, listWorkspacesByDirectory } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const settings = createConnectServerSettings({
        hostname: "secure.host.com",
        port: 9443,
        password: "super-secret",
      });

      const importData = {
        version: 1 as const,
        exportedAt: new Date().toISOString(),
        workspaces: [
          {
            name: "Secure Workspace",
            directory: "/tmp/secure-ws",
            serverSettings: settings,
          },
        ],
      };

      await importWorkspaces(importData);

      const workspaces = await listWorkspacesByDirectory("/tmp/secure-ws");
      expect(workspaces).toHaveLength(1);
      const workspace = workspaces[0]!;
      expect(workspace.name).toBe("Secure Workspace");
      expect(workspace.serverSettings).toEqual(settings);
      expect(workspace.serverSettings.agent.transport).toBe("ssh");
      if (workspace.serverSettings.agent.transport === "ssh") {
        expect(workspace.serverSettings.agent.password).toBe("super-secret");
      }
    });

    test("import trims whitespace from name and directory", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { importWorkspaces, listWorkspacesByDirectory } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      const importData = {
        version: 1 as const,
        exportedAt: new Date().toISOString(),
        workspaces: [
          {
            name: "  Padded Name  ",
            directory: "  /tmp/padded-dir  ",
            serverSettings: getDefaultServerSettings(),
          },
        ],
      };

      const result = await importWorkspaces(importData);
      expect(result.created).toBe(1);
      expect(result.failed).toBe(0);

      // Detail should have trimmed values
      expect(result.details[0]!.name).toBe("Padded Name");
      expect(result.details[0]!.directory).toBe("/tmp/padded-dir");

      // Workspace should be findable by trimmed directory
      const workspaces = await listWorkspacesByDirectory("/tmp/padded-dir");
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]!.name).toBe("Padded Name");
      expect(workspaces[0]!.directory).toBe("/tmp/padded-dir");
    });

    test("import creates workspaces regardless of matching directories (even with whitespace)", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { createWorkspace, importWorkspaces, listWorkspaces } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();

      // Pre-create a workspace with a trimmed directory
      const existing = createTestWorkspace({ name: "Existing", directory: "/tmp/trim-dup" });
      await createWorkspace(existing);

      const importData = {
        version: 1 as const,
        exportedAt: new Date().toISOString(),
        workspaces: [
          {
            name: "New With Spaces",
            directory: "  /tmp/trim-dup  ",
            serverSettings: getDefaultServerSettings(),
          },
        ],
      };

      const result = await importWorkspaces(importData);
      // No dedup — always creates new workspaces
      expect(result.created).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);

      // Should now have 2 workspaces
      const workspaces = await listWorkspaces();
      expect(workspaces).toHaveLength(2);
    });

    test("export then import round-trip reproduces same configs", async () => {
      const { ensureDataDirectories } = await import("../../src/persistence/database");
      const { createWorkspace, exportWorkspaces, importWorkspaces, listWorkspaces } = await import("../../src/persistence/workspaces");
      const { closeDatabase } = await import("../../src/persistence/database");

      await ensureDataDirectories();

      // Create workspaces
      const ws1 = createTestWorkspace({ name: "Round Trip A", directory: "/tmp/rt-a" });
      ws1.serverSettings = createConnectServerSettings({
        hostname: "rt-server.com",
        port: 7777,
        password: "rt-pass",
      });
      const ws2 = createTestWorkspace({ name: "Round Trip B", directory: "/tmp/rt-b" });
      await createWorkspace(ws1);
      await createWorkspace(ws2);

      // Export
      const exported = await exportWorkspaces();
      expect(exported.workspaces).toHaveLength(2);

      // Clear database and re-import
      const originalDataDir = testDataDir;
      closeDatabase();
      await rm(testDataDir, { recursive: true, force: true });
      expect(await pathExists(originalDataDir)).toBe(false);

      // Need fresh DB
      testDataDir = await mkdtemp(join(tmpdir(), "clanky-workspace-test-"));
      process.env["CLANKY_DATA_DIR"] = testDataDir;

      // Re-import persistence modules with fresh DB
      // Dynamic re-import won't give us a fresh module, so we use the functions we already have
      const { ensureDataDirectories: ensureDataDirs2 } = await import("../../src/persistence/database");
      await ensureDataDirs2();

      const result = await importWorkspaces(exported);
      expect(result.created).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);

      // Verify the imported workspaces match the exported configs
      const workspaces = await listWorkspaces();
      expect(workspaces).toHaveLength(2);

      for (const exportedConfig of exported.workspaces) {
        const found = workspaces.find((w) => w.directory === exportedConfig.directory);
        expect(found).not.toBeNull();
        expect(found!.name).toBe(exportedConfig.name);
        expect(found!.serverSettings).toEqual(exportedConfig.serverSettings);
      }
    });
  });
});
