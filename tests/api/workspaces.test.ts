/**
 * API integration tests for workspace endpoints.
 * Tests use actual HTTP requests to a test server.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { serve, type Server } from "bun";
import { apiRoutes } from "../../src/api";
import { ensureDataDirectories } from "../../src/persistence/database";
import { backendManager } from "../../src/core/backend-manager";
import { createMockBackend } from "../mocks/mock-backend";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { loopManager } from "../../src/core/loop-manager";

// Default test model for loop creation (model is now required)
const testModel = { providerID: "test-provider", modelID: "test-model", variant: "" };

function makeServerSettings(overrides?: {
  mode?: "spawn" | "connect";
  hostname?: string;
  port?: number;
  username?: string;
  password?: string;
  identityFile?: string;
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
        ...(overrides?.identityFile ? { identityFile: overrides.identityFile } : {}),
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

describe("Workspace API Integration", () => {
  let testDataDir: string;
  let testWorkDir: string;
  let server: Server<unknown>;
  let baseUrl: string;

  async function createPullTestRepos(): Promise<{
    originDir: string;
    sourceDir: string;
    cloneDir: string;
    defaultBranch: string;
  }> {
    const originDir = await mkdtemp(join(tmpdir(), "ralpher-pull-origin-"));
    const sourceDir = await mkdtemp(join(tmpdir(), "ralpher-pull-source-"));
    const cloneParentDir = await mkdtemp(join(tmpdir(), "ralpher-pull-clone-parent-"));
    const cloneDir = join(cloneParentDir, "workspace");

    await Bun.$`git init --bare ${originDir}`.quiet();
    await Bun.$`git init ${sourceDir}`.quiet();
    await Bun.$`git -C ${sourceDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${sourceDir} config user.name "Test User"`.quiet();
    await Bun.write(join(sourceDir, "README.md"), "# Test\n");
    await Bun.$`git -C ${sourceDir} add README.md`.quiet();
    await Bun.$`git -C ${sourceDir} commit -m "Initial commit"`.quiet();

    const defaultBranch = (await Bun.$`git -C ${sourceDir} branch --show-current`.text()).trim();
    await Bun.$`git -C ${sourceDir} remote add origin ${originDir}`.quiet();
    await Bun.$`git -C ${sourceDir} push -u origin ${defaultBranch}`.quiet();
    await Bun.$`git --git-dir=${originDir} symbolic-ref HEAD refs/heads/${defaultBranch}`.quiet();
    await Bun.$`git clone ${originDir} ${cloneDir}`.quiet();
    await Bun.$`git -C ${cloneDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${cloneDir} config user.name "Test User"`.quiet();

    return {
      originDir,
      sourceDir,
      cloneDir,
      defaultBranch,
    };
  }

  beforeAll(async () => {
    // Create temp directories
    testDataDir = await mkdtemp(join(tmpdir(), "ralpher-api-workspace-test-data-"));
    testWorkDir = await mkdtemp(join(tmpdir(), "ralpher-api-workspace-test-work-"));

    // Set env var for persistence before importing modules
    process.env["RALPHER_DATA_DIR"] = testDataDir;

    // Ensure directories exist
    await ensureDataDirectories();

    // Initialize git repo in test work directory
    await Bun.$`git init ${testWorkDir}`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.name "Test User"`.quiet();
    await Bun.$`touch ${testWorkDir}/README.md`.quiet();
    await Bun.$`git -C ${testWorkDir} add .`.quiet();
    await Bun.$`git -C ${testWorkDir} commit -m "Initial commit"`.quiet();

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
    await rm(testWorkDir, { recursive: true, force: true });

    // Clear env
    delete process.env["RALPHER_DATA_DIR"];
  });

  // Clean up workspaces before each test
  beforeEach(async () => {
    const { getDatabase } = await import("../../src/persistence/database");
    // Clear the workspaces and loops tables
    const db = getDatabase();
    db.run("DELETE FROM loops WHERE workspace_id IS NOT NULL");
    db.run("DELETE FROM workspaces");
  });

  describe("GET /api/workspaces", () => {
    test("returns empty array when no workspaces exist", async () => {
      const response = await fetch(`${baseUrl}/api/workspaces`);
      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data).toEqual([]);
    });

    test("returns list of workspaces with loop counts", async () => {
      // Create a workspace first
      const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Workspace",
          directory: testWorkDir,
        serverSettings: makeServerSettings(),
        }),
      });
      expect(createResponse.ok).toBe(true);

      // Get the list
      const response = await fetch(`${baseUrl}/api/workspaces`);
      expect(response.ok).toBe(true);
      const data = await response.json();

      expect(data.length).toBe(1);
      expect(data[0].name).toBe("Test Workspace");
      expect(data[0].directory).toBe(testWorkDir);
    });

    test("hides SSH secrets by default and includes them with sensitive=true", async () => {
      const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "SSH Workspace",
          directory: testWorkDir,
          serverSettings: makeServerSettings({
            mode: "connect",
            hostname: "ssh.example.com",
            port: 2222,
            username: "deploy",
            password: "super-secret",
            identityFile: "/keys/id_ed25519",
          }),
        }),
      });
      expect(createResponse.ok).toBe(true);

      const response = await fetch(`${baseUrl}/api/workspaces`);
      expect(response.ok).toBe(true);
      const data = await response.json() as Array<{
        serverSettings: {
          agent: Record<string, unknown>;
        };
      }>;

      expect(data).toHaveLength(1);
      expect(data[0]!.serverSettings.agent).toEqual(expect.objectContaining({
        transport: "ssh",
        hostname: "ssh.example.com",
        port: 2222,
        username: "deploy",
      }));
      expect(data[0]!.serverSettings.agent["password"]).toBeUndefined();
      expect(data[0]!.serverSettings.agent["identityFile"]).toBeUndefined();

      const sensitiveResponse = await fetch(`${baseUrl}/api/workspaces?sensitive=true`);
      expect(sensitiveResponse.ok).toBe(true);
      const sensitiveData = await sensitiveResponse.json() as Array<{
        serverSettings: {
          agent: Record<string, unknown>;
        };
      }>;

      expect(sensitiveData[0]!.serverSettings.agent["password"]).toBe("super-secret");
      expect(sensitiveData[0]!.serverSettings.agent["identityFile"]).toBe("/keys/id_ed25519");
    });
  });

  describe("sensitive workspace reads", () => {
    test("hides secrets on detail and server-settings reads unless sensitive=true", async () => {
      const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Detail Workspace",
          directory: testWorkDir,
          serverSettings: makeServerSettings({
            mode: "connect",
            hostname: "detail.example.com",
            username: "builder",
            password: "detail-secret",
            identityFile: "/keys/detail",
          }),
        }),
      });
      expect(createResponse.ok).toBe(true);
      const created = await createResponse.json() as { id: string };

      const detailResponse = await fetch(`${baseUrl}/api/workspaces/${created.id}`);
      expect(detailResponse.ok).toBe(true);
      const detail = await detailResponse.json() as {
        serverSettings: { agent: Record<string, unknown> };
      };
      expect(detail.serverSettings.agent["password"]).toBeUndefined();
      expect(detail.serverSettings.agent["identityFile"]).toBeUndefined();

      const sensitiveDetailResponse = await fetch(`${baseUrl}/api/workspaces/${created.id}?sensitive=true`);
      expect(sensitiveDetailResponse.ok).toBe(true);
      const sensitiveDetail = await sensitiveDetailResponse.json() as {
        serverSettings: { agent: Record<string, unknown> };
      };
      expect(sensitiveDetail.serverSettings.agent["password"]).toBe("detail-secret");
      expect(sensitiveDetail.serverSettings.agent["identityFile"]).toBe("/keys/detail");

      const settingsResponse = await fetch(`${baseUrl}/api/workspaces/${created.id}/server-settings`);
      expect(settingsResponse.ok).toBe(true);
      const settings = await settingsResponse.json() as {
        agent: Record<string, unknown>;
      };
      expect(settings.agent["password"]).toBeUndefined();
      expect(settings.agent["identityFile"]).toBeUndefined();

      const sensitiveSettingsResponse = await fetch(
        `${baseUrl}/api/workspaces/${created.id}/server-settings?sensitive=true`,
      );
      expect(sensitiveSettingsResponse.ok).toBe(true);
      const sensitiveSettings = await sensitiveSettingsResponse.json() as {
        agent: Record<string, unknown>;
      };
      expect(sensitiveSettings.agent["password"]).toBe("detail-secret");
      expect(sensitiveSettings.agent["identityFile"]).toBe("/keys/detail");
    });

    test("hides secrets from exports unless sensitive=true", async () => {
      const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Export Workspace",
          directory: testWorkDir,
          serverSettings: makeServerSettings({
            mode: "connect",
            hostname: "export.example.com",
            username: "exporter",
            password: "export-secret",
            identityFile: "/keys/export",
          }),
        }),
      });
      expect(createResponse.ok).toBe(true);

      const exportResponse = await fetch(`${baseUrl}/api/workspaces/export`);
      expect(exportResponse.ok).toBe(true);
      const exported = await exportResponse.json() as {
        workspaces: Array<{
          serverSettings: { agent: Record<string, unknown> };
        }>;
      };
      expect(exported.workspaces[0]!.serverSettings.agent["password"]).toBeUndefined();
      expect(exported.workspaces[0]!.serverSettings.agent["identityFile"]).toBeUndefined();

      const sensitiveExportResponse = await fetch(`${baseUrl}/api/workspaces/export?sensitive=true`);
      expect(sensitiveExportResponse.ok).toBe(true);
      const sensitiveExport = await sensitiveExportResponse.json() as {
        workspaces: Array<{
          serverSettings: { agent: Record<string, unknown> };
        }>;
      };
      expect(sensitiveExport.workspaces[0]!.serverSettings.agent["password"]).toBe("export-secret");
      expect(sensitiveExport.workspaces[0]!.serverSettings.agent["identityFile"]).toBe("/keys/export");
    });
  });

  describe("POST /api/workspaces", () => {
    test("creates a new workspace", async () => {
      const response = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "New Workspace",
          directory: testWorkDir,
        serverSettings: makeServerSettings(),
        }),
      });

      expect(response.ok).toBe(true);
      const data = await response.json();

      expect(data.id).toBeDefined();
      expect(data.name).toBe("New Workspace");
      expect(data.directory).toBe(testWorkDir);
      expect(data.createdAt).toBeDefined();
      expect(data.updatedAt).toBeDefined();
    });

    test("fails if name is missing", async () => {
      const response = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directory: testWorkDir,
        serverSettings: makeServerSettings(),
        }),
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(400);
    });

    test("fails if directory is missing", async () => {
      const response = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Workspace",
        }),
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(400);
    });

    test("fails if directory is not a git repository", async () => {
      const nonGitDir = await mkdtemp(join(tmpdir(), "non-git-"));

      const response = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Non-Git Workspace",
          directory: nonGitDir,
        serverSettings: makeServerSettings(),
        }),
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.message).toContain("git repository");

      // Cleanup
      await rm(nonGitDir, { recursive: true, force: true });
    });

    test("allows creating multiple workspaces with the same directory on the same server target", async () => {
      // Create first workspace
      const firstResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "First Workspace",
          directory: testWorkDir,
        serverSettings: makeServerSettings(),
        }),
      });
      expect(firstResponse.ok).toBe(true);
      const firstData = await firstResponse.json();

      // Create another workspace with the same directory
      const secondResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Second Workspace",
          directory: testWorkDir,
        serverSettings: makeServerSettings(),
        }),
      });

      // Should succeed — workspaces are identified by ID, not directory
      expect(secondResponse.status).toBe(201);
      const secondData = await secondResponse.json();
      expect(secondData.id).not.toBe(firstData.id);
      expect(secondData.name).toBe("Second Workspace");
    });

    test("allows the same directory on a different server target", async () => {
      const firstResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Local Workspace",
          directory: testWorkDir,
          serverSettings: makeServerSettings({ mode: "spawn" }),
        }),
      });
      expect(firstResponse.ok).toBe(true);

      const secondResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Remote Workspace",
          directory: testWorkDir,
          serverSettings: makeServerSettings({
            mode: "connect",
            hostname: "example-remote.test",
            port: 2222,
          }),
        }),
      });
      expect(secondResponse.status).toBe(201);

      const listResponse = await fetch(`${baseUrl}/api/workspaces`);
      expect(listResponse.ok).toBe(true);
      const workspaces = await listResponse.json();
      expect(workspaces).toHaveLength(2);
      expect(workspaces.map((workspace: { name: string }) => workspace.name)).toEqual([
        "Local Workspace",
        "Remote Workspace",
      ]);
    });
  });

  describe("GET /api/workspaces/:id", () => {
    test("returns workspace by id", async () => {
      // Create a workspace
      const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Get By ID Test",
          directory: testWorkDir,
        serverSettings: makeServerSettings(),
        }),
      });
      const workspace = await createResponse.json();

      // Get by ID
      const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`);
      expect(response.ok).toBe(true);
      const data = await response.json();

      expect(data.id).toBe(workspace.id);
      expect(data.name).toBe("Get By ID Test");
    });

    test("returns 404 for non-existent id", async () => {
      const response = await fetch(`${baseUrl}/api/workspaces/non-existent-id`);
      expect(response.status).toBe(404);
    });
  });

  describe("PUT /api/workspaces/:id", () => {
    test("updates workspace name", async () => {
      // Create a workspace
      const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Original Name",
          directory: testWorkDir,
        serverSettings: makeServerSettings(),
        }),
      });
      const workspace = await createResponse.json();

      // Update name
      const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Updated Name",
        }),
      });
      expect(response.ok).toBe(true);
      const data = await response.json();

      expect(data.name).toBe("Updated Name");
      expect(data.directory).toBe(testWorkDir);
    });

    test("redacts workspace secrets by default and includes them with sensitive=true", async () => {
      const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Sensitive Workspace",
          directory: testWorkDir,
          serverSettings: makeServerSettings({
            mode: "connect",
            hostname: "sensitive.example.com",
            username: "deploy",
            password: "put-secret",
            identityFile: "/keys/put",
          }),
        }),
      });
      const workspace = await createResponse.json() as { id: string };

      const defaultResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Sensitive Workspace Updated",
        }),
      });
      expect(defaultResponse.ok).toBe(true);
      const redactedWorkspace = await defaultResponse.json() as {
        serverSettings: { agent: Record<string, unknown> };
      };
      expect(redactedWorkspace.serverSettings.agent["password"]).toBeUndefined();
      expect(redactedWorkspace.serverSettings.agent["identityFile"]).toBeUndefined();

      const sensitiveResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}?sensitive=true`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Sensitive Workspace Renamed Again",
        }),
      });
      expect(sensitiveResponse.ok).toBe(true);
      const sensitiveWorkspace = await sensitiveResponse.json() as {
        serverSettings: { agent: Record<string, unknown> };
      };
      expect(sensitiveWorkspace.serverSettings.agent["password"]).toBe("put-secret");
      expect(sensitiveWorkspace.serverSettings.agent["identityFile"]).toBe("/keys/put");
    });

    test("returns 404 for non-existent id", async () => {
      const response = await fetch(`${baseUrl}/api/workspaces/non-existent-id`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "New Name",
        }),
      });
      expect(response.status).toBe(404);
    });
  });

  describe("DELETE /api/workspaces/:id", () => {
    test("deletes workspace with no loops", async () => {
      // Create a workspace
      const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Delete Me",
          directory: testWorkDir,
        serverSettings: makeServerSettings(),
        }),
      });
      const workspace = await createResponse.json();

      // Delete it
      const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, {
        method: "DELETE",
      });
      expect(response.ok).toBe(true);

      // Verify it's gone
      const getResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`);
      expect(getResponse.status).toBe(404);
    });

    test("resets backend manager state after deleting workspace", async () => {
      const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Delete Cleanup",
          directory: testWorkDir,
          serverSettings: makeServerSettings(),
        }),
      });
      expect(createResponse.ok).toBe(true);
      const workspace = await createResponse.json();
      const resetSpy = spyOn(backendManager, "resetWorkspaceConnection");

      try {
        const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, {
          method: "DELETE",
        });

        expect(response.ok).toBe(true);
        expect(resetSpy).toHaveBeenCalledWith(workspace.id);
      } finally {
        resetSpy.mockRestore();
      }
    });

    test("returns 404 for non-existent id", async () => {
      const response = await fetch(`${baseUrl}/api/workspaces/non-existent-id`, {
        method: "DELETE",
      });
      expect(response.status).toBe(404);
    });
  });

  describe("POST /api/workspaces/:id/pull-latest-changes", () => {
    test("pulls the latest changes for the default branch", async () => {
      const repos = await createPullTestRepos();

      try {
        await Bun.write(join(repos.sourceDir, "README.md"), "# Test\nUpdated remotely\n");
        await Bun.$`git -C ${repos.sourceDir} add README.md`.quiet();
        await Bun.$`git -C ${repos.sourceDir} commit -m "Update README"`.quiet();
        await Bun.$`git -C ${repos.sourceDir} push origin ${repos.defaultBranch}`.quiet();

        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Pull Test Workspace",
            directory: repos.cloneDir,
          serverSettings: makeServerSettings(),
          }),
        });
        expect(createResponse.ok).toBe(true);
        const workspace = await createResponse.json();

        const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/pull-latest-changes`, {
          method: "POST",
        });
        expect(response.ok).toBe(true);

        const data = await response.json();
        expect(data.success).toBe(true);
        expect(data.defaultBranch).toBe(repos.defaultBranch);
        expect(data.currentBranch).toBe(repos.defaultBranch);

        const readme = await Bun.file(join(repos.cloneDir, "README.md")).text();
        expect(readme).toContain("Updated remotely");
      } finally {
        await rm(repos.originDir, { recursive: true, force: true });
        await rm(repos.sourceDir, { recursive: true, force: true });
        await rm(join(repos.cloneDir, ".."), { recursive: true, force: true });
      }
    });

    test("fails when the workspace is not on its default branch", async () => {
      const repos = await createPullTestRepos();

      try {
        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Branch Mismatch Workspace",
            directory: repos.cloneDir,
          serverSettings: makeServerSettings(),
          }),
        });
        expect(createResponse.ok).toBe(true);
        const workspace = await createResponse.json();

        await Bun.$`git -C ${repos.cloneDir} checkout -b feature/test-branch`.quiet();

        const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/pull-latest-changes`, {
          method: "POST",
        });
        expect(response.status).toBe(409);

        const data = await response.json();
        expect(data.error).toBe("branch_mismatch");
        expect(data.message).toContain(repos.defaultBranch);
      } finally {
        await rm(repos.originDir, { recursive: true, force: true });
        await rm(repos.sourceDir, { recursive: true, force: true });
        await rm(join(repos.cloneDir, ".."), { recursive: true, force: true });
      }
    });

    test("fails when the workspace has uncommitted changes", async () => {
      const repos = await createPullTestRepos();

      try {
        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Dirty Workspace",
            directory: repos.cloneDir,
          serverSettings: makeServerSettings(),
          }),
        });
        expect(createResponse.ok).toBe(true);
        const workspace = await createResponse.json();

        await Bun.write(join(repos.cloneDir, "README.md"), "# Test\nLocally modified\n");

        const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/pull-latest-changes`, {
          method: "POST",
        });
        expect(response.status).toBe(409);

        const data = await response.json();
        expect(data.error).toBe("uncommitted_changes");
        expect(data.message).toContain(repos.defaultBranch);
      } finally {
        await rm(repos.originDir, { recursive: true, force: true });
        await rm(repos.sourceDir, { recursive: true, force: true });
        await rm(join(repos.cloneDir, ".."), { recursive: true, force: true });
      }
    });

    test("returns a generic message when pull latest fails with a git command error", async () => {
      const repos = await createPullTestRepos();

      try {
        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Missing Remote Workspace",
            directory: repos.cloneDir,
          serverSettings: makeServerSettings(),
          }),
        });
        expect(createResponse.ok).toBe(true);
        const workspace = await createResponse.json();

        await Bun.$`git -C ${repos.cloneDir} remote remove origin`.quiet();

        const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/pull-latest-changes`, {
          method: "POST",
        });
        expect(response.status).toBe(409);

        const data = await response.json();
        expect(data.error).toBe("git_pull_failed");
        expect(data.message).toBe("Unable to pull the latest changes from the remote repository.");
        expect(data.message).not.toContain(repos.originDir);
      } finally {
        await rm(repos.originDir, { recursive: true, force: true });
        await rm(repos.sourceDir, { recursive: true, force: true });
        await rm(join(repos.cloneDir, ".."), { recursive: true, force: true });
      }
    });
  });

  describe("Loop creation with workspaceId", () => {
    test("creates a loop using workspaceId and touches the workspace", async () => {
      // Step 1: Create a workspace
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Loop Test Workspace",
          directory: testWorkDir,
        serverSettings: makeServerSettings(),
        }),
      });
      expect(workspaceResponse.ok).toBe(true);
      const workspace = await workspaceResponse.json();
      const originalUpdatedAt = workspace.updatedAt;

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Step 2: Create a loop using the workspaceId (draft to avoid git operations)
      const loopResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: workspace.id,
          prompt: "Test prompt for loop creation",
          name: "Test Loop",
          attachments: [],
          model: testModel,
          cheapModel: { mode: "same-as-loop" },
          maxIterations: null,
          maxConsecutiveErrors: 10,
          activityTimeoutSeconds: 300,
          stopPattern: "<promise>COMPLETE</promise>$",
          git: { branchPrefix: "", commitScope: "" },
          baseBranch: "main",
          useWorktree: true,
          clearPlanningFolder: false,
          planMode: false,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          draft: true,
        }),
      });
      expect(loopResponse.ok).toBe(true);
      const loop = await loopResponse.json();

      // Verify the loop was created with the workspace's directory
      expect(loop.config.directory).toBe(testWorkDir);
      expect(loop.config.workspaceId).toBe(workspace.id);
      expect(loop.state.status).toBe("draft");

      // Step 3: Verify the workspace was touched (updatedAt should be updated)
      const updatedWorkspaceResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`);
      expect(updatedWorkspaceResponse.ok).toBe(true);
      const updatedWorkspace = await updatedWorkspaceResponse.json();
      expect(new Date(updatedWorkspace.updatedAt).getTime()).toBeGreaterThan(
        new Date(originalUpdatedAt).getTime()
      );

    });

    test("fails when creating loop with non-existent workspaceId", async () => {
      const response = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "non-existent-workspace-id",
          prompt: "Test prompt",
          name: "Test Loop",
          attachments: [],
          model: testModel,
          cheapModel: { mode: "same-as-loop" },
          maxIterations: null,
          maxConsecutiveErrors: 10,
          activityTimeoutSeconds: 300,
          stopPattern: "<promise>COMPLETE</promise>$",
          git: { branchPrefix: "", commitScope: "" },
          baseBranch: "main",
          useWorktree: true,
          clearPlanningFolder: false,
          planMode: false,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          draft: true,
        }),
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe("workspace_not_found");
    });

    test("fails when creating loop without workspaceId", async () => {
      const response = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Test prompt",
          draft: true,
          planMode: false,
        }),
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("validation_error");
      expect(data.message).toContain("workspaceId");
    });
  });

  describe("Workspace Server Settings Endpoints", () => {
    describe("GET /api/workspaces/:id/server-settings", () => {
      test("returns workspace server settings", async () => {
        // Create a workspace
        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Server Settings Test",
            directory: testWorkDir,
          serverSettings: makeServerSettings(),
          }),
        });
        const workspace = await createResponse.json();

        // Get server settings
        const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/server-settings`);
        expect(response.ok).toBe(true);
        const settings = await response.json();

        // Should have default settings
        expect(settings.agent.transport).toBe("stdio");
      });

      test("returns 404 for non-existent workspace", async () => {
        const response = await fetch(`${baseUrl}/api/workspaces/non-existent-id/server-settings`);
        expect(response.status).toBe(404);
      });
    });

    describe("PUT /api/workspaces/:id/server-settings", () => {
      test("updates workspace server settings", async () => {
        // Create a workspace
        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Update Settings Test",
            directory: testWorkDir,
          serverSettings: makeServerSettings(),
          }),
        });
        const workspace = await createResponse.json();

        // Update server settings
        const newSettings = makeServerSettings({
          mode: "connect",
          hostname: "example.com",
          port: 8080,
        });

        const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/server-settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(newSettings),
        });
        expect(response.ok).toBe(true);
        const updatedSettings = await response.json();

        expect(updatedSettings.agent.transport).toBe("ssh");
        expect(updatedSettings.agent.hostname).toBe("example.com");
        expect(updatedSettings.agent.port).toBe(8080);

        // Verify persistence by fetching again
        const getResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/server-settings`);
        const fetchedSettings = await getResponse.json();
        expect(fetchedSettings.agent.transport).toBe("ssh");
        expect(fetchedSettings.agent.hostname).toBe("example.com");
      });

      test("redacts updated server settings by default and includes them with sensitive=true", async () => {
        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Sensitive Server Settings",
            directory: testWorkDir,
            serverSettings: makeServerSettings(),
          }),
        });
        const workspace = await createResponse.json() as { id: string };

        const redactedUpdateResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/server-settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(makeServerSettings({
            mode: "connect",
            hostname: "redacted.example.com",
            username: "builder",
            password: "settings-secret",
            identityFile: "/keys/settings",
          })),
        });
        expect(redactedUpdateResponse.ok).toBe(true);
        const redactedSettings = await redactedUpdateResponse.json() as {
          agent: Record<string, unknown>;
        };
        expect(redactedSettings.agent["password"]).toBeUndefined();
        expect(redactedSettings.agent["identityFile"]).toBeUndefined();

        const sensitiveUpdateResponse = await fetch(
          `${baseUrl}/api/workspaces/${workspace.id}/server-settings?sensitive=true`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(makeServerSettings({
              mode: "connect",
              hostname: "sensitive.example.com",
              username: "builder",
              password: "settings-secret-2",
              identityFile: "/keys/settings-2",
            })),
          },
        );
        expect(sensitiveUpdateResponse.ok).toBe(true);
        const sensitiveSettings = await sensitiveUpdateResponse.json() as {
          agent: Record<string, unknown>;
        };
        expect(sensitiveSettings.agent["password"]).toBe("settings-secret-2");
        expect(sensitiveSettings.agent["identityFile"]).toBe("/keys/settings-2");
      });

      test("rejects invalid mode", async () => {
        // Create a workspace
        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Invalid Mode Test",
            directory: testWorkDir,
          serverSettings: makeServerSettings(),
          }),
        });
        const workspace = await createResponse.json();

        // Try to update with invalid mode
        const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/server-settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent: {
              provider: "opencode",
              transport: "invalid-transport",
            },
          }),
        });
        expect(response.ok).toBe(false);
        expect(response.status).toBe(400);
      });

      test("returns 404 for non-existent workspace", async () => {
        const response = await fetch(`${baseUrl}/api/workspaces/non-existent-id/server-settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(makeServerSettings({ mode: "spawn" })),
        });
        expect(response.status).toBe(404);
      });

      test("does not emit a reset event when submitted server settings are unchanged", async () => {
        const { loopEventEmitter } = await import("../../src/core/event-emitter");

        const initialSettings = makeServerSettings({
          mode: "connect",
          hostname: "unchanged.example.com",
          port: 2222,
        });

        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "No-op Server Settings Update",
            directory: testWorkDir,
            serverSettings: initialSettings,
          }),
        });
        const workspace = await createResponse.json();

        const events: Array<{ type: string; workspaceId?: string }> = [];
        const unsubscribe = loopEventEmitter.subscribe((event) => {
          const eventType = (event as { type: string }).type;
          if (eventType === "server.reset") {
            events.push(event as { type: string; workspaceId?: string });
          }
        });

        try {
          const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/server-settings`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(initialSettings),
          });

          expect(response.ok).toBe(true);
          const updatedSettings = await response.json();
          expect(updatedSettings).toEqual(initialSettings);
          expect(events.length).toBe(0);
        } finally {
          unsubscribe();
        }
      });
    });

    describe("GET /api/workspaces/:id/server-settings/status", () => {
      test("returns connection status for workspace", async () => {
        // Create a workspace
        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Status Test",
            directory: testWorkDir,
          serverSettings: makeServerSettings(),
          }),
        });
        const workspace = await createResponse.json();

        // Get connection status
        const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/server-settings/status`);
        expect(response.ok).toBe(true);
        const status = await response.json();

        // Should return a valid status object
        expect(status).toHaveProperty("connected");
        expect(status).toHaveProperty("provider");
        expect(status).toHaveProperty("transport");
        expect(status).toHaveProperty("capabilities");
        expect(status.capabilities).not.toContain("queueActivePrompt");
      });

      test("returns 404 for non-existent workspace", async () => {
        const response = await fetch(`${baseUrl}/api/workspaces/non-existent-id/server-settings/status`);
        expect(response.status).toBe(404);
      });
    });

    describe("POST /api/workspaces/:id/server-settings/test", () => {
      test("tests connection with current settings", async () => {
        // Create a workspace
        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Test Connection Test",
            directory: testWorkDir,
          serverSettings: makeServerSettings(),
          }),
        });
        const workspace = await createResponse.json();

        // Test connection (with spawn mode and mock backend, this should succeed)
        const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/server-settings/test`, {
          method: "POST",
        });
        expect(response.ok).toBe(true);
        const result = await response.json();

        expect(result).toHaveProperty("success");
      });

      test("tests connection with proposed settings", async () => {
        // Create a workspace
        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Test Proposed Settings",
            directory: testWorkDir,
          serverSettings: makeServerSettings(),
          }),
        });
        const workspace = await createResponse.json();

        // Test with proposed settings
        const proposedSettings = makeServerSettings({ mode: "spawn" });

        const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/server-settings/test`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(proposedSettings),
        });
        expect(response.ok).toBe(true);
        const result = await response.json();

        expect(result).toHaveProperty("success");
      });

      test("returns 400 when proposed settings body is invalid JSON", async () => {
        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Invalid JSON Settings Test",
            directory: testWorkDir,
          serverSettings: makeServerSettings(),
          }),
        });
        const workspace = await createResponse.json();

        const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/server-settings/test`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{invalid-json",
        });

        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toBe("invalid_json");
      });

      test("returns 400 when proposed settings fail schema validation", async () => {
        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Invalid Settings Shape Test",
            directory: testWorkDir,
          serverSettings: makeServerSettings(),
          }),
        });
        const workspace = await createResponse.json();

        const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/server-settings/test`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent: {
              provider: "opencode",
              transport: "invalid-transport",
            },
          }),
        });

        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toBe("validation_error");
      });

      test("returns 404 for non-existent workspace", async () => {
        const response = await fetch(`${baseUrl}/api/workspaces/non-existent-id/server-settings/test`, {
          method: "POST",
        });
        expect(response.status).toBe(404);
      });
    });

    describe("Workspace creation with serverSettings", () => {
      test("creates workspace with default server settings when not provided", async () => {
        const response = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Default Settings Workspace",
            directory: testWorkDir,
          serverSettings: makeServerSettings(),
          }),
        });

        expect(response.ok).toBe(true);
        const workspace = await response.json();

        expect(workspace.serverSettings).toBeDefined();
        expect(workspace.serverSettings.agent.transport).toBe("stdio");
      });

      test("creates workspace with custom server settings when provided", async () => {
        const customSettings = makeServerSettings({
          mode: "connect",
          hostname: "custom.server.com",
          port: 9000,
        });

        const response = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Custom Settings Workspace",
            directory: testWorkDir,
            serverSettings: customSettings,
          }),
        });

        expect(response.ok).toBe(true);
        const workspace = await response.json();

        expect(workspace.serverSettings).toBeDefined();
        expect(workspace.serverSettings.agent.transport).toBe("ssh");
        expect(workspace.serverSettings.agent.hostname).toBe("custom.server.com");
        expect(workspace.serverSettings.agent.port).toBe(9000);
      });
    });

    describe("Workspace update with serverSettings", () => {
      test("updates workspace name and server settings together", async () => {
        // Create a workspace
        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Original Name",
            directory: testWorkDir,
          serverSettings: makeServerSettings(),
          }),
        });
        const workspace = await createResponse.json();

        // Update both name and server settings
        const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "New Name",
            serverSettings: makeServerSettings({
              mode: "connect",
              hostname: "new-server.com",
              port: 7000,
            }),
          }),
        });

        expect(response.ok).toBe(true);
        const updated = await response.json();

        expect(updated.name).toBe("New Name");
        expect(updated.serverSettings.agent.transport).toBe("ssh");
        expect(updated.serverSettings.agent.hostname).toBe("new-server.com");
        expect(updated.serverSettings.agent.port).toBe(7000);
      });

      test("updates only name, keeping server settings", async () => {
        // Create a workspace with custom settings
        const customSettings = makeServerSettings({
          mode: "connect",
          hostname: "original.server.com",
          port: 5000,
        });

        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Original Name",
            directory: testWorkDir,
            serverSettings: customSettings,
          }),
        });
        const workspace = await createResponse.json();

        // Update only name
        const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Updated Name Only",
          }),
        });

        expect(response.ok).toBe(true);
        const updated = await response.json();

        expect(updated.name).toBe("Updated Name Only");
        // Server settings should remain unchanged
        expect(updated.serverSettings.agent.transport).toBe("ssh");
        expect(updated.serverSettings.agent.hostname).toBe("original.server.com");
        expect(updated.serverSettings.agent.port).toBe(5000);
      });

      test("resets connection when serverSettings are updated via PUT /api/workspaces/:id", async () => {
        // Import the event emitter to capture events
        const { loopEventEmitter } = await import("../../src/core/event-emitter");
        
        // Create a workspace
        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Workspace Settings Update Test",
            directory: testWorkDir,
          serverSettings: makeServerSettings(),
          }),
        });
        const workspace = await createResponse.json();

        // Set up event listener to capture the server.reset event
        // Cast event to any since server.reset is not in the LoopEvent type union
        const events: Array<{ type: string; workspaceId?: string }> = [];
        const unsubscribe = loopEventEmitter.subscribe((event) => {
          const eventType = (event as { type: string }).type;
          if (eventType === "server.reset") {
            events.push(event as { type: string; workspaceId?: string });
          }
        });

        try {
          // Update workspace with new serverSettings
          const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "Updated Name",
              serverSettings: makeServerSettings({
                mode: "connect",
                hostname: "new-server.com",
                port: 8080,
              }),
            }),
          });

          expect(response.ok).toBe(true);
          const updated = await response.json();
          expect(updated.name).toBe("Updated Name");
          expect(updated.serverSettings.agent.hostname).toBe("new-server.com");

          // Verify a server.reset event was emitted for this workspace
          expect(events.length).toBe(1);
          expect(events[0]!.type).toBe("server.reset");
          expect(events[0]!.workspaceId).toBe(workspace.id);
        } finally {
          unsubscribe();
        }
      });

      test("does NOT emit a reset event when only name is updated", async () => {
        // Import the event emitter to capture events
        const { loopEventEmitter } = await import("../../src/core/event-emitter");
        
        // Create a workspace
        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "No Reset Test",
            directory: testWorkDir,
          serverSettings: makeServerSettings(),
          }),
        });
        const workspace = await createResponse.json();

        // Set up event listener to capture the server.reset event
        // Cast event to any since server.reset is not in the LoopEvent type union
        const events: Array<{ type: string; workspaceId?: string }> = [];
        const unsubscribe = loopEventEmitter.subscribe((event) => {
          const eventType = (event as { type: string }).type;
          if (eventType === "server.reset") {
            events.push(event as { type: string; workspaceId?: string });
          }
        });

        try {
          // Update workspace with only name (no serverSettings)
          const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "Updated Name Only Again",
            }),
          });

          expect(response.ok).toBe(true);
          const updated = await response.json();
          expect(updated.name).toBe("Updated Name Only Again");

          // Verify NO server.reset event was emitted
          expect(events.length).toBe(0);
        } finally {
          unsubscribe();
        }
      });

      test("does NOT emit a reset event when submitted server settings are unchanged", async () => {
        const { loopEventEmitter } = await import("../../src/core/event-emitter");

        const originalSettings = makeServerSettings({
          mode: "connect",
          hostname: "original.server.com",
          port: 5000,
        });

        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "No-op Workspace Update Test",
            directory: testWorkDir,
            serverSettings: originalSettings,
          }),
        });
        const workspace = await createResponse.json();

        const events: Array<{ type: string; workspaceId?: string }> = [];
        const unsubscribe = loopEventEmitter.subscribe((event) => {
          const eventType = (event as { type: string }).type;
          if (eventType === "server.reset") {
            events.push(event as { type: string; workspaceId?: string });
          }
        });

        try {
          const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "Renamed Without Reset",
              serverSettings: originalSettings,
            }),
          });

          expect(response.ok).toBe(true);
          const updated = await response.json();
          expect(updated.name).toBe("Renamed Without Reset");
          expect(updated.serverSettings).toEqual(originalSettings);
          expect(events.length).toBe(0);
        } finally {
          unsubscribe();
        }
      });
    });

    describe("Workspace settings isolation", () => {
      test("updating one workspace settings does not affect another workspace", async () => {
        // Create two separate git repositories
        const testWorkDir2 = await mkdtemp(join(tmpdir(), "ralpher-api-workspace-test-work2-"));
        await Bun.$`git init ${testWorkDir2}`.quiet();
        await Bun.$`git -C ${testWorkDir2} config user.email "test@test.com"`.quiet();
        await Bun.$`git -C ${testWorkDir2} config user.name "Test User"`.quiet();
        await Bun.$`touch ${testWorkDir2}/README.md`.quiet();
        await Bun.$`git -C ${testWorkDir2} add .`.quiet();
        await Bun.$`git -C ${testWorkDir2} commit -m "Initial commit"`.quiet();

        try {
          // Create workspace A with specific settings
          const settingsA = makeServerSettings({
            mode: "connect",
            hostname: "server-a.com",
            port: 5001,
          });

          const createResponseA = await fetch(`${baseUrl}/api/workspaces`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "Workspace A",
              directory: testWorkDir,
              serverSettings: settingsA,
            }),
          });
          expect(createResponseA.ok).toBe(true);
          const workspaceA = await createResponseA.json();

          // Create workspace B with different settings
          const settingsB = makeServerSettings({
            mode: "connect",
            hostname: "server-b.com",
            port: 5002,
          });

          const createResponseB = await fetch(`${baseUrl}/api/workspaces`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "Workspace B",
              directory: testWorkDir2,
              serverSettings: settingsB,
            }),
          });
          expect(createResponseB.ok).toBe(true);
          const workspaceB = await createResponseB.json();

          // Verify initial settings are different
          expect(workspaceA.serverSettings.agent.hostname).toBe("server-a.com");
          expect(workspaceA.serverSettings.agent.port).toBe(5001);

          expect(workspaceB.serverSettings.agent.hostname).toBe("server-b.com");
          expect(workspaceB.serverSettings.agent.port).toBe(5002);

          // Update workspace A's settings
          const newSettingsA = makeServerSettings({
            mode: "connect",
            hostname: "updated-server-a.com",
            port: 6001,
          });

          const updateResponseA = await fetch(`${baseUrl}/api/workspaces/${workspaceA.id}/server-settings`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(newSettingsA),
          });
          expect(updateResponseA.ok).toBe(true);

          // Verify workspace A was updated
          const getResponseA = await fetch(`${baseUrl}/api/workspaces/${workspaceA.id}`);
          expect(getResponseA.ok).toBe(true);
          const updatedA = await getResponseA.json();
          expect(updatedA.serverSettings.agent.hostname).toBe("updated-server-a.com");
          expect(updatedA.serverSettings.agent.port).toBe(6001);

          // CRITICAL: Verify workspace B was NOT affected
          const getResponseB = await fetch(`${baseUrl}/api/workspaces/${workspaceB.id}`);
          expect(getResponseB.ok).toBe(true);
          const unchangedB = await getResponseB.json();
          expect(unchangedB.serverSettings.agent.hostname).toBe("server-b.com");
          expect(unchangedB.serverSettings.agent.port).toBe(5002);

          // Also verify via the list endpoint
          const listResponse = await fetch(`${baseUrl}/api/workspaces`);
          expect(listResponse.ok).toBe(true);
          const workspaces = await listResponse.json();
          
          const listedA = workspaces.find((w: { id: string }) => w.id === workspaceA.id);
          const listedB = workspaces.find((w: { id: string }) => w.id === workspaceB.id);

          expect(listedA.serverSettings.agent.hostname).toBe("updated-server-a.com");
          expect(listedB.serverSettings.agent.hostname).toBe("server-b.com");
        } finally {
          // Cleanup the second test directory
          await rm(testWorkDir2, { recursive: true, force: true });
        }
      });
    });
  });

  describe("POST /api/workspaces/:id/archived-loops/purge", () => {
    test("purges only archived loops for the selected workspace", async () => {
      const createWorkspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Bulk Purge Workspace",
          directory: testWorkDir,
        serverSettings: makeServerSettings(),
        }),
      });
      expect(createWorkspaceResponse.ok).toBe(true);
      const workspace = await createWorkspaceResponse.json();

      const originalGetAllLoops = loopManager.getAllLoops;
      const originalPurgeLoop = loopManager.purgeLoop;

      const purgedIds: string[] = [];
      loopManager.getAllLoops = async () => [
        {
          config: { id: "loop-archived-1", workspaceId: workspace.id },
          state: { status: "deleted" },
        } as any,
        {
          config: { id: "loop-archived-2", workspaceId: workspace.id },
          state: { status: "pushed", reviewMode: { addressable: false } },
        } as any,
        {
          config: { id: "loop-feedback", workspaceId: workspace.id },
          state: { status: "pushed", reviewMode: { addressable: true } },
        } as any,
        {
          config: { id: "loop-other-workspace", workspaceId: "ws-other" },
          state: { status: "deleted" },
        } as any,
      ];
      loopManager.purgeLoop = async (loopId: string) => {
        purgedIds.push(loopId);
        return { success: true };
      };

      try {
        const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/archived-loops/purge`, {
          method: "POST",
        });
        expect(response.ok).toBe(true);
        const body = await response.json();

        expect(body.success).toBe(true);
        expect(body.workspaceId).toBe(workspace.id);
        expect(body.totalArchived).toBe(2);
        expect(body.purgedCount).toBe(2);
        expect(body.purgedLoopIds).toEqual(["loop-archived-1", "loop-archived-2"]);
        expect(body.failures).toEqual([]);
        expect(purgedIds).toEqual(["loop-archived-1", "loop-archived-2"]);
      } finally {
        loopManager.getAllLoops = originalGetAllLoops;
        loopManager.purgeLoop = originalPurgeLoop;
      }
    });

    test("uses bounded concurrency and preserves purge result ordering", async () => {
      const createWorkspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Concurrent Purge Workspace",
          directory: testWorkDir,
        serverSettings: makeServerSettings(),
        }),
      });
      expect(createWorkspaceResponse.ok).toBe(true);
      const workspace = await createWorkspaceResponse.json();

      const originalGetAllLoops = loopManager.getAllLoops;
      const originalPurgeLoop = loopManager.purgeLoop;

      let activePurges = 0;
      let maxConcurrentPurges = 0;
      const archivedLoopIds = ["loop-1", "loop-2", "loop-3", "loop-4", "loop-5", "loop-6"];

      loopManager.getAllLoops = async () => archivedLoopIds.map((loopId) => ({
        config: { id: loopId, workspaceId: workspace.id },
        state: { status: "deleted" },
      })) as any;

      loopManager.purgeLoop = async (loopId: string) => {
        activePurges++;
        maxConcurrentPurges = Math.max(maxConcurrentPurges, activePurges);
        await new Promise((resolve) => setTimeout(resolve, loopId === "loop-1" ? 10 : 1));
        activePurges--;

        if (loopId === "loop-3") {
          return { success: false, error: "permission denied" };
        }

        if (loopId === "loop-5") {
          throw new Error("remote executor disconnected");
        }

        return { success: true };
      };

      try {
        const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/archived-loops/purge`, {
          method: "POST",
        });
        expect(response.ok).toBe(true);
        const body = await response.json();

        expect(body.success).toBe(true);
        expect(body.workspaceId).toBe(workspace.id);
        expect(body.totalArchived).toBe(6);
        expect(body.purgedCount).toBe(4);
        expect(body.purgedLoopIds).toEqual(["loop-1", "loop-2", "loop-4", "loop-6"]);
        expect(body.failures).toEqual([
          { loopId: "loop-3", error: "permission denied" },
          { loopId: "loop-5", error: "Error: remote executor disconnected" },
        ]);
        expect(maxConcurrentPurges).toBeLessThanOrEqual(4);
      } finally {
        loopManager.getAllLoops = originalGetAllLoops;
        loopManager.purgeLoop = originalPurgeLoop;
      }
    });

    test("returns 404 for a missing workspace", async () => {
      const response = await fetch(`${baseUrl}/api/workspaces/non-existent-id/archived-loops/purge`, {
        method: "POST",
      });

      expect(response.status).toBe(404);
    });
  });

  describe("Export/Import", () => {
    describe("GET /api/workspaces/export", () => {
      test("returns valid export format with version 1 and empty workspaces", async () => {
        const response = await fetch(`${baseUrl}/api/workspaces/export`);
        expect(response.ok).toBe(true);
        const data = await response.json();
        expect(data.version).toBe(1);
        expect(data.exportedAt).toBeDefined();
        expect(data.workspaces).toEqual([]);
      });

      test("returns redacted exports by default and full exports with sensitive=true", async () => {
        // Create two workspaces with different settings
        const testWorkDir2 = await mkdtemp(join(tmpdir(), "ralpher-api-ws-export-"));
        await Bun.$`git init ${testWorkDir2}`.quiet();
        await Bun.$`git -C ${testWorkDir2} config user.email "test@test.com"`.quiet();
        await Bun.$`git -C ${testWorkDir2} config user.name "Test User"`.quiet();
        await Bun.$`touch ${testWorkDir2}/README.md`.quiet();
        await Bun.$`git -C ${testWorkDir2} add .`.quiet();
        await Bun.$`git -C ${testWorkDir2} commit -m "Initial commit"`.quiet();

        try {
          await fetch(`${baseUrl}/api/workspaces`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "Export WS A",
              directory: testWorkDir,
              serverSettings: makeServerSettings({
                mode: "connect",
                hostname: "export-a.com",
                port: 3001,
                password: "secret-a",
              }),
            }),
          });

          await fetch(`${baseUrl}/api/workspaces`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "Export WS B",
              directory: testWorkDir2,
            serverSettings: makeServerSettings(),
            }),
          });

          const response = await fetch(`${baseUrl}/api/workspaces/export`);
          expect(response.ok).toBe(true);
          const data = await response.json();

          expect(data.version).toBe(1);
          expect(data.workspaces).toHaveLength(2);

          // Each workspace should have name, directory, serverSettings
          for (const ws of data.workspaces) {
            expect(ws.name).toBeDefined();
            expect(ws.directory).toBeDefined();
            expect(ws.serverSettings).toBeDefined();
            // Should NOT have internal fields
            expect(ws.id).toBeUndefined();
            expect(ws.createdAt).toBeUndefined();
            expect(ws.updatedAt).toBeUndefined();
          }

          // Verify password is redacted by default
          const wsA = data.workspaces.find((w: { name: string }) => w.name === "Export WS A");
          expect(wsA).toBeDefined();
          expect(wsA.serverSettings.agent.password).toBeUndefined();

          const sensitiveResponse = await fetch(`${baseUrl}/api/workspaces/export?sensitive=true`);
          expect(sensitiveResponse.ok).toBe(true);
          const sensitiveData = await sensitiveResponse.json();
          const sensitiveWsA = sensitiveData.workspaces.find((w: { name: string }) => w.name === "Export WS A");
          expect(sensitiveWsA).toBeDefined();
          expect(sensitiveWsA.serverSettings.agent.password).toBe("secret-a");
        } finally {
          await rm(testWorkDir2, { recursive: true, force: true });
        }
      });
    });

    describe("POST /api/workspaces/import", () => {
      test("creates workspaces from valid payload (directories must be valid git repos)", async () => {
        // Create two real git repo directories for import
        const importDir1 = await mkdtemp(join(tmpdir(), "ralpher-api-import-1-"));
        const importDir2 = await mkdtemp(join(tmpdir(), "ralpher-api-import-2-"));
        await Bun.$`git init ${importDir1}`.quiet();
        await Bun.$`git -C ${importDir1} config user.email "test@test.com"`.quiet();
        await Bun.$`git -C ${importDir1} config user.name "Test User"`.quiet();
        await Bun.$`touch ${importDir1}/README.md`.quiet();
        await Bun.$`git -C ${importDir1} add .`.quiet();
        await Bun.$`git -C ${importDir1} commit -m "Init"`.quiet();
        await Bun.$`git init ${importDir2}`.quiet();
        await Bun.$`git -C ${importDir2} config user.email "test@test.com"`.quiet();
        await Bun.$`git -C ${importDir2} config user.name "Test User"`.quiet();
        await Bun.$`touch ${importDir2}/README.md`.quiet();
        await Bun.$`git -C ${importDir2} add .`.quiet();
        await Bun.$`git -C ${importDir2} commit -m "Init"`.quiet();

        try {
          const importPayload = {
            version: 1,
            exportedAt: new Date().toISOString(),
            workspaces: [
              {
                name: "Imported WS 1",
                directory: importDir1,
                serverSettings: makeServerSettings({
                  mode: "connect",
                  hostname: "imported.server.com",
                  port: 9000,
                }),
              },
              {
                name: "Imported WS 2",
                directory: importDir2,
                serverSettings: makeServerSettings({ mode: "spawn" }),
              },
            ],
          };

          const response = await fetch(`${baseUrl}/api/workspaces/import`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(importPayload),
          });
          expect(response.ok).toBe(true);
          const result = await response.json();

          expect(result.created).toBe(2);
          expect(result.skipped).toBe(0);
          expect(result.failed).toBe(0);
          expect(result.details).toHaveLength(2);
          expect(result.details[0].status).toBe("created");
          expect(result.details[1].status).toBe("created");

          // Verify workspaces appear in the list
          const listResponse = await fetch(`${baseUrl}/api/workspaces`);
          const workspaces = await listResponse.json();
          expect(workspaces).toHaveLength(2);
        } finally {
          await rm(importDir1, { recursive: true, force: true });
          await rm(importDir2, { recursive: true, force: true });
        }
      });

      test("fails validation for non-existent directories", async () => {
        const importPayload = {
          version: 1,
          exportedAt: new Date().toISOString(),
          workspaces: [
            {
              name: "Non-Existent Dir WS",
              directory: "/tmp/does-not-exist-at-all-" + Date.now(),
              serverSettings: makeServerSettings({ mode: "spawn" }),
            },
          ],
        };

        const response = await fetch(`${baseUrl}/api/workspaces/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(importPayload),
        });
        expect(response.ok).toBe(true);
        const result = await response.json();

        expect(result.created).toBe(0);
        expect(result.failed).toBe(1);
        expect(result.details).toHaveLength(1);
        expect(result.details[0].status).toBe("failed");
        expect(result.details[0].reason).toContain("does not exist");
      });

      test("fails validation for directories that are not git repos", async () => {
        // Create a real directory that is NOT a git repo
        const nonGitDir = await mkdtemp(join(tmpdir(), "ralpher-api-import-nongit-"));

        try {
          const importPayload = {
            version: 1,
            exportedAt: new Date().toISOString(),
            workspaces: [
              {
                name: "Non-Git Dir WS",
                directory: nonGitDir,
                serverSettings: makeServerSettings({ mode: "spawn" }),
              },
            ],
          };

          const response = await fetch(`${baseUrl}/api/workspaces/import`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(importPayload),
          });
          expect(response.ok).toBe(true);
          const result = await response.json();

          expect(result.created).toBe(0);
          expect(result.failed).toBe(1);
          expect(result.details).toHaveLength(1);
          expect(result.details[0].status).toBe("failed");
          expect(result.details[0].reason).toContain("not a git repository");
        } finally {
          await rm(nonGitDir, { recursive: true, force: true });
        }
      });

      test("reports mix of created, skipped, and failed entries", async () => {
        // Create a workspace first (for skip detection)
        await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Existing WS",
            directory: testWorkDir,
          serverSettings: makeServerSettings(),
          }),
        });

        // Create a valid git repo for the "new" entry
        const importDir = await mkdtemp(join(tmpdir(), "ralpher-api-import-mix-"));
        await Bun.$`git init ${importDir}`.quiet();
        await Bun.$`git -C ${importDir} config user.email "test@test.com"`.quiet();
        await Bun.$`git -C ${importDir} config user.name "Test User"`.quiet();
        await Bun.$`touch ${importDir}/README.md`.quiet();
        await Bun.$`git -C ${importDir} add .`.quiet();
        await Bun.$`git -C ${importDir} commit -m "Init"`.quiet();

        try {
          const importPayload = {
            version: 1,
            exportedAt: new Date().toISOString(),
            workspaces: [
              {
                name: "New Import",
                directory: importDir,
                serverSettings: makeServerSettings({ mode: "spawn" }),
              },
              {
                name: "Duplicate Import",
                directory: testWorkDir,
                serverSettings: makeServerSettings({ mode: "spawn" }),
              },
              {
                name: "Invalid Import",
                directory: "/tmp/nonexistent-dir-" + Date.now(),
                serverSettings: makeServerSettings({ mode: "spawn" }),
              },
            ],
          };

          const response = await fetch(`${baseUrl}/api/workspaces/import`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(importPayload),
          });
          expect(response.ok).toBe(true);
          const result = await response.json();

          expect(result.created).toBe(2);
          expect(result.skipped).toBe(0);
          expect(result.failed).toBe(1);
          expect(result.details).toHaveLength(3);

          const createdDetails = result.details.filter((d: { status: string }) => d.status === "created");
          const failedDetail = result.details.find((d: { status: string }) => d.status === "failed");
          expect(createdDetails).toHaveLength(2);
          expect(createdDetails.map((d: { name: string }) => d.name)).toEqual(["New Import", "Duplicate Import"]);
          expect(failedDetail).toBeDefined();
          expect(failedDetail.name).toBe("Invalid Import");
        } finally {
          await rm(importDir, { recursive: true, force: true });
        }
      });

      test("trims whitespace from name and directory before validation", async () => {
        const importPayload = {
          version: 1,
          exportedAt: new Date().toISOString(),
          workspaces: [
            {
              name: "  Trimmed WS  ",
              directory: `  ${testWorkDir}  `,
              serverSettings: makeServerSettings({ mode: "spawn" }),
            },
          ],
        };

        const response = await fetch(`${baseUrl}/api/workspaces/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(importPayload),
        });
        expect(response.ok).toBe(true);
        const result = await response.json();

        expect(result.created).toBe(1);
        expect(result.failed).toBe(0);

        // Verify the workspace was stored with trimmed values
        const listResponse = await fetch(`${baseUrl}/api/workspaces`);
        const workspaces = await listResponse.json();
        expect(workspaces).toHaveLength(1);
        expect(workspaces[0].name).toBe("Trimmed WS");
        expect(workspaces[0].directory).toBe(testWorkDir);
      });

      test("validates schema and returns 400 for invalid data", async () => {
        // Missing required fields
        const response = await fetch(`${baseUrl}/api/workspaces/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ invalid: true }),
        });
        expect(response.status).toBe(400);
      });

      test("returns 400 for unknown version", async () => {
        const response = await fetch(`${baseUrl}/api/workspaces/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version: 999,
            exportedAt: new Date().toISOString(),
            workspaces: [],
          }),
        });
        expect(response.status).toBe(400);
      });

      test("round-trip: export then import on clean database reproduces same workspaces", async () => {
        // Create workspaces
        await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "RT Workspace",
            directory: testWorkDir,
            serverSettings: makeServerSettings({
              mode: "connect",
              hostname: "rt.server.com",
              port: 5555,
              password: "rt-password",
            }),
          }),
        });

        // Export
        const exportResponse = await fetch(`${baseUrl}/api/workspaces/export?sensitive=true`);
        expect(exportResponse.ok).toBe(true);
        const exportedData = await exportResponse.json();
        expect(exportedData.workspaces).toHaveLength(1);

        // Clear database (via beforeEach pattern — manually delete)
        const { getDatabase } = await import("../../src/persistence/database");
        const db = getDatabase();
        db.run("DELETE FROM workspaces");

        // Import the exported data
        const importResponse = await fetch(`${baseUrl}/api/workspaces/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(exportedData),
        });
        expect(importResponse.ok).toBe(true);
        const importResult = await importResponse.json();
        expect(importResult.created).toBe(1);
        expect(importResult.failed).toBe(0);

        // Verify the imported workspace matches
        const listResponse = await fetch(`${baseUrl}/api/workspaces?sensitive=true`);
        const workspaces = await listResponse.json();
        expect(workspaces).toHaveLength(1);
        expect(workspaces[0].name).toBe("RT Workspace");
        expect(workspaces[0].serverSettings.agent.hostname).toBe("rt.server.com");
        expect(workspaces[0].serverSettings.agent.port).toBe(5555);
        expect(workspaces[0].serverSettings.agent.password).toBe("rt-password");
      });
    });
  });
});
