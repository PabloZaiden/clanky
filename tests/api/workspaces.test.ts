/**
 * API integration tests for workspace endpoints.
 * Tests use actual HTTP requests to a test server.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { type Server } from "bun";
import { serveNativeApiRoutes } from "../native-api-server";
import { initializeDatabase } from "../../src/persistence/database";
import { backendManager } from "../../src/core/backend-manager";
import { sshServerManager } from "../../src/core/ssh-server-manager";
import { createMockBackend } from "../mocks/mock-backend";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { fetchTestLocalExecutionHost } from "../setup";
import type { ExecutionHostRef } from "@/shared";

import { createWorkspace, getWorkspace } from "../../src/persistence/workspaces";
import {
  configureGitRepository,
  createTempBareGitRepository,
  getCurrentBranch,
  initializeGitRepository,
  runGit,
} from "../helpers/git-fixtures";

// Default test model for task creation (model is now required)
const testModel = { providerID: "test-provider", modelID: "test-model", variant: "" };

function makeServerSettings(provider: "opencode" | "copilot" = "opencode") {
  return {
    agent: {
      provider,
    },
  };
}

describe("Workspace API Integration", () => {
  let testDataDir: string;
  let testWorkDir: string;
  let server: Server<unknown>;
  let baseUrl: string;
  let localExecutionHost: Extract<ExecutionHostRef, { kind: "local" }>;
  let testDefaultBranch = "";

  async function createPullTestRepos(): Promise<{
    originDir: string;
    sourceDir: string;
    cloneDir: string;
    defaultBranch: string;
  }> {
    const originDir = await createTempBareGitRepository({ prefix: "clanky-pull-origin-" });
    const sourceDir = await mkdtemp(join(tmpdir(), "clanky-pull-source-"));
    const cloneParentDir = await mkdtemp(join(tmpdir(), "clanky-pull-clone-parent-"));
    const cloneDir = join(cloneParentDir, "workspace");

    await initializeGitRepository(sourceDir, { initialCommit: "readme" });

    const defaultBranch = await getCurrentBranch(sourceDir);
    await runGit(sourceDir, ["remote", "add", "origin", originDir]);
    await runGit(sourceDir, ["push", "-u", "origin", defaultBranch]);
    await runGit(originDir, ["--git-dir", originDir, "symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`]);
    await runGit(cloneParentDir, ["clone", originDir, cloneDir]);
    await configureGitRepository(cloneDir);

    return {
      originDir,
      sourceDir,
      cloneDir,
      defaultBranch,
    };
  }

  beforeAll(async () => {
    // Create temp directories
    testDataDir = await mkdtemp(join(tmpdir(), "clanky-api-workspace-test-data-"));
    testWorkDir = await mkdtemp(join(tmpdir(), "clanky-api-workspace-test-work-"));

    // Set env var for persistence before importing modules
    process.env["CLANKY_DATA_DIR"] = testDataDir;

    // Ensure directories exist
    await initializeDatabase();

    // Initialize git repo in test work directory
    await initializeGitRepository(testWorkDir, { initialCommit: "readme" });
    testDefaultBranch = await getCurrentBranch(testWorkDir);

    // Set up backend manager with test executor factory
    backendManager.setBackendForTesting(createMockBackend());
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    // Start test server on random port
    server = serveNativeApiRoutes();
    baseUrl = server.url.toString().replace(/\/$/, "");
    localExecutionHost = await fetchTestLocalExecutionHost(baseUrl);
  });

  afterAll(async () => {
    // Stop server
    server.stop();

    // Reset backend manager
    backendManager.resetForTesting();
    sshServerManager.setExecutorFactoryForTesting(null);

    // Cleanup temp directories
    await rm(testDataDir, { recursive: true, force: true });
    await rm(testWorkDir, { recursive: true, force: true });

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
    db.run("DELETE FROM ssh_servers");
    sshServerManager.setExecutorFactoryForTesting(null);
  });

  describe("GET /api/workspaces", () => {

    test("returns list of workspaces with task counts", async () => {
      // Create a workspace first
      const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Workspace",
          directory: testWorkDir,
          executionHost: localExecutionHost,
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

  });

  describe("GET /api/workspaces/execution-targets", () => {
    test("lists the local stdio target", async () => {
      const response = await fetch(`${baseUrl}/api/workspaces/execution-targets`);
      expect(response.ok).toBe(true);
      const targets = await response.json() as Array<{
        ref: { kind: string; nodeId?: string };
        availability: string;
      }>;
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({
        ref: { kind: "local" },
        availability: "local",
      });
      expect(targets[0]!.ref.nodeId?.length).toBeGreaterThan(0);
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
          executionHost: localExecutionHost,
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
      expect(data.allowClankyContext).toBe(false);
      expect(data.workspaceType).toBe("git");
    });

    test("creates and persists a directory workspace without requiring Git", async () => {
      const nonGitDir = await mkdtemp(join(tmpdir(), "directory-workspace-"));

      const response = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Directory Workspace",
          directory: nonGitDir,
          workspaceType: "directory",
          executionHost: localExecutionHost,
          serverSettings: makeServerSettings(),
        }),
      });

      expect(response.status).toBe(201);
      const created = await response.json() as { id: string; workspaceType: string };
      expect(created.workspaceType).toBe("directory");

      const persisted = await getWorkspace(created.id);
      expect(persisted?.workspaceType).toBe("directory");

      await rm(nonGitDir, { recursive: true, force: true });
    });

    test("keeps a directory workspace type even when its directory contains Git", async () => {
      const response = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Explicit Directory Workspace",
          directory: testWorkDir,
          workspaceType: "directory",
          executionHost: localExecutionHost,
          serverSettings: makeServerSettings(),
        }),
      });

      expect(response.status).toBe(201);
      const created = await response.json() as { id: string; workspaceType: string };
      expect(created.workspaceType).toBe("directory");

      const updateResponse = await fetch(`${baseUrl}/api/workspaces/${created.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceType: "git",
          name: "Still Directory",
        }),
      });
      expect(updateResponse.status).toBe(200);
      expect((await updateResponse.json()).workspaceType).toBe("directory");
    });

    test("rejects an unavailable execution host", async () => {
      const response = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Owned Workspace",
          directory: testWorkDir,
          executionHost: { kind: "mesh", nodeId: "attacker-node" },
          serverSettings: makeServerSettings(),
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "execution_host_unavailable",
      });
    });

    test("persists an opted-in Clanky context setting", async () => {
      const response = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Opted-in Workspace",
          directory: testWorkDir,
          executionHost: localExecutionHost,
          serverSettings: makeServerSettings(),
          allowClankyContext: true,
        }),
      });

      expect(response.ok).toBe(true);
      const created = await response.json() as { id: string; allowClankyContext?: boolean };
      expect(created.allowClankyContext).toBe(true);

      const persisted = await getWorkspace(created.id);
      expect(persisted?.allowClankyContext).toBe(true);
    });

    test("fails if directory is not a git repository", async () => {
      const nonGitDir = await mkdtemp(join(tmpdir(), "non-git-"));

      const response = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Non-Git Workspace",
          directory: nonGitDir,
          executionHost: localExecutionHost,
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

  });

  describe("POST /api/workspaces/:id/exec", () => {
    async function createExecutionWorkspace(name: string): Promise<{ id: string }> {
      const response = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          directory: testWorkDir,
          executionHost: localExecutionHost,
          serverSettings: makeServerSettings(),
        }),
      });
      expect(response.status).toBe(201);
      return await response.json() as { id: string };
    }

    test("executes a command with an arbitrary absolute cwd", async () => {
      const workspace = await createExecutionWorkspace("Execution Workspace");
      const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "pwd",
          args: [],
          cwd: tmpdir(),
        }),
      });

      expect(response.ok).toBe(true);
      expect(await response.json()).toMatchObject({
        workspaceId: workspace.id,
        success: true,
        stdout: `${tmpdir()}\n`,
        stderr: "",
        exitCode: 0,
      });
    });

    test("returns command failures in the response envelope", async () => {
      const workspace = await createExecutionWorkspace("Failed Execution Workspace");
      const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "sh",
          args: ["-c", "printf 'failure\\n' >&2; exit 7"],
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        workspaceId: workspace.id,
        success: false,
        stdout: "",
        stderr: "failure\n",
        exitCode: 7,
      });
    });

    test("rejects a cwd that does not exist", async () => {
      const workspace = await createExecutionWorkspace("Invalid Cwd Workspace");
      const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "pwd",
          args: [],
          cwd: join(testWorkDir, "does-not-exist"),
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "workspace_exec_cwd_not_found",
      });
    });

    test("rejects command output larger than the response limit", async () => {
      const workspace = await createExecutionWorkspace("Large Output Workspace");
      const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "head",
          args: ["-c", "8388609", "/dev/zero"],
        }),
      });

      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({
        error: "workspace_exec_output_limit_exceeded",
      });
    });
  });

  describe("GET /api/workspaces/:id", () => {

    test("returns 404 for non-existent id", async () => {
      const response = await fetch(`${baseUrl}/api/workspaces/non-existent-id`);
      expect(response.status).toBe(404);
    });
  });

  describe("PUT /api/workspaces/:id", () => {

    test("updates and persists archived workspace state", async () => {
      const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Archivable Workspace",
          directory: testWorkDir,
          executionHost: localExecutionHost,
          serverSettings: makeServerSettings(),
        }),
      });
      expect(createResponse.ok).toBe(true);
      const workspace = await createResponse.json() as {
        id: string;
        archived?: boolean;
        allowClankyContext?: boolean;
      };
      expect(workspace.archived).toBe(false);
      expect(workspace.allowClankyContext).toBe(false);

      const archiveResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          archived: true,
          allowClankyContext: true,
        }),
      });
      expect(archiveResponse.ok).toBe(true);
      const archivedWorkspace = await archiveResponse.json() as {
        archived?: boolean;
        allowClankyContext?: boolean;
      };
      expect(archivedWorkspace.archived).toBe(true);
      expect(archivedWorkspace.allowClankyContext).toBe(true);

      const persistedArchivedWorkspace = await getWorkspace(workspace.id);
      expect(persistedArchivedWorkspace?.archived).toBe(true);
      expect(persistedArchivedWorkspace?.allowClankyContext).toBe(true);

      const unarchiveResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          archived: false,
          allowClankyContext: false,
        }),
      });
      expect(unarchiveResponse.ok).toBe(true);
      const unarchivedWorkspace = await unarchiveResponse.json() as {
        archived?: boolean;
        allowClankyContext?: boolean;
      };
      expect(unarchivedWorkspace.archived).toBe(false);
      expect(unarchivedWorkspace.allowClankyContext).toBe(false);

      const persistedUnarchivedWorkspace = await getWorkspace(workspace.id);
      expect(persistedUnarchivedWorkspace?.archived).toBe(false);
      expect(persistedUnarchivedWorkspace?.allowClankyContext).toBe(false);
    });

    test("refreshes the binding when the selected SSH host configuration changes", async () => {
      const createServerResponse = await fetch(`${baseUrl}/api/ssh-servers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Mutable SSH Host",
          address: "old-host.example",
          username: "builder",
          repositoriesBasePath: null,
        }),
      });
      expect(createServerResponse.status).toBe(201);
      const serverId = (await createServerResponse.json() as { config: { id: string } }).config.id;
      const executionHost = { kind: "ssh" as const, serverId };

      const initialHostsResponse = await fetch(`${baseUrl}/api/execution-hosts`);
      expect(initialHostsResponse.status).toBe(200);
      const initialHost = (await initialHostsResponse.json() as Array<{
        ref: ExecutionHostRef;
        targetKey: string;
        revision: number;
      }>).find((host) => host.ref.kind === "ssh" && host.ref.serverId === serverId);
      expect(initialHost).toBeDefined();

      const createWorkspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "SSH Binding Refresh",
          directory: testWorkDir,
          executionHost,
          serverSettings: makeServerSettings(),
        }),
      });
      expect(createWorkspaceResponse.status).toBe(201);
      const workspace = await createWorkspaceResponse.json() as {
        id: string;
        executionHostBinding: { targetKey: string; revision: number };
        executionTargetRevision: number;
      };

      const updateServerResponse = await fetch(`${baseUrl}/api/ssh-servers/${serverId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: "new-host.example" }),
      });
      expect(updateServerResponse.status).toBe(200);

      const refreshedHostsResponse = await fetch(`${baseUrl}/api/execution-hosts`);
      expect(refreshedHostsResponse.status).toBe(200);
      const refreshedHost = (await refreshedHostsResponse.json() as Array<{
        ref: ExecutionHostRef;
        targetKey: string;
        revision: number;
      }>).find((host) => host.ref.kind === "ssh" && host.ref.serverId === serverId);
      expect(refreshedHost).toBeDefined();
      expect(refreshedHost!.targetKey).not.toBe(workspace.executionHostBinding.targetKey);
      expect(refreshedHost!.revision).toBeGreaterThan(workspace.executionHostBinding.revision);

      const refreshWorkspaceResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ executionHost }),
      });
      expect(refreshWorkspaceResponse.status).toBe(200);
      const refreshedWorkspace = await refreshWorkspaceResponse.json() as {
        executionHostBinding: { targetKey: string; revision: number };
        executionTargetRevision: number;
      };
      expect(refreshedWorkspace.executionHostBinding).toMatchObject({
        targetKey: refreshedHost!.targetKey,
        revision: refreshedHost!.revision,
      });
      expect(refreshedWorkspace.executionTargetRevision).toBe(
        workspace.executionTargetRevision + 1,
      );
    });

  });

  describe("DELETE /api/workspaces/:id", () => {
    test("deletes workspace with no tasks", async () => {
      // Create a workspace
      const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Delete Me",
          directory: testWorkDir,
          executionHost: localExecutionHost,
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

    test("deletes auto-provisioned server directory when requested", async () => {
      const sourceDirectory = await mkdtemp(join(tmpdir(), "clanky-auto-source-"));
      await Bun.write(join(sourceDirectory, "README.md"), "# Auto\n");
      const sshServer = await sshServerManager.createServer({
        name: "Source Server",
        address: "127.0.0.1",
        username: "tester",
        repositoriesBasePath: null,
      });
      sshServerManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

      await createWorkspace({
        id: "auto-delete-workspace",
        name: "Auto Delete Workspace",
        directory: testWorkDir,
        workspaceType: "git",
        executionTargetRevision: 1,
        executionHostBinding: {
          host: { kind: "ssh", serverId: sshServer.config.id },
          targetKey: `ssh:${sshServer.config.id}`,
          revision: 1,
        },
        serverSettings: makeServerSettings(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceDirectory,
        basePath: tmpdir(),
        repoUrl: "git@example.com:test/repo.git",
      });

      const response = await fetch(`${baseUrl}/api/workspaces/auto-delete-workspace`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteServerDirectory: true }),
      });

      expect(response.ok).toBe(true);
      expect(await Bun.file(join(sourceDirectory, "README.md")).exists()).toBe(false);
      expect(await getWorkspace("auto-delete-workspace")).toBeNull();
    });

    test("accepts auto-provisioned base paths with trailing slashes", async () => {
      const sourceDirectory = await mkdtemp(join(tmpdir(), "clanky-auto-source-"));
      await Bun.write(join(sourceDirectory, "README.md"), "# Auto\n");
      const sshServer = await sshServerManager.createServer({
        name: "Trailing Slash Source Server",
        address: "127.0.0.1",
        username: "tester",
        repositoriesBasePath: null,
      });
      sshServerManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

      await createWorkspace({
        id: "auto-delete-trailing-base-workspace",
        name: "Auto Delete Trailing Base Workspace",
        directory: testWorkDir,
        workspaceType: "git",
        executionTargetRevision: 1,
        executionHostBinding: {
          host: { kind: "ssh", serverId: sshServer.config.id },
          targetKey: `ssh:${sshServer.config.id}`,
          revision: 1,
        },
        serverSettings: makeServerSettings(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceDirectory,
        basePath: `${tmpdir()}/`,
        repoUrl: "git@example.com:test/repo.git",
      });

      const response = await fetch(`${baseUrl}/api/workspaces/auto-delete-trailing-base-workspace`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteServerDirectory: true }),
      });

      expect(response.ok).toBe(true);
      expect(await Bun.file(join(sourceDirectory, "README.md")).exists()).toBe(false);
      expect(await getWorkspace("auto-delete-trailing-base-workspace")).toBeNull();
    });

    test("preserves auto-provisioned server directory when option is false", async () => {
      const sourceDirectory = await mkdtemp(join(tmpdir(), "clanky-auto-preserve-"));
      await Bun.write(join(sourceDirectory, "README.md"), "# Auto\n");
      const sshServer = await sshServerManager.createServer({
        name: "Preserve Server",
        address: "127.0.0.1",
        username: "tester",
        repositoriesBasePath: null,
      });
      sshServerManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

      await createWorkspace({
        id: "auto-preserve-workspace",
        name: "Auto Preserve Workspace",
        directory: testWorkDir,
        workspaceType: "git",
        executionTargetRevision: 1,
        executionHostBinding: {
          host: { kind: "ssh", serverId: sshServer.config.id },
          targetKey: `ssh:${sshServer.config.id}`,
          revision: 1,
        },
        serverSettings: makeServerSettings(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceDirectory,
        basePath: tmpdir(),
        repoUrl: "git@example.com:test/repo.git",
      });

      const response = await fetch(`${baseUrl}/api/workspaces/auto-preserve-workspace`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteServerDirectory: false }),
      });

      expect(response.ok).toBe(true);
      expect(await Bun.file(join(sourceDirectory, "README.md")).exists()).toBe(true);
      expect(await getWorkspace("auto-preserve-workspace")).toBeNull();
      await rm(sourceDirectory, { recursive: true, force: true });
    });

    test("preserves workspace record when server directory deletion fails", async () => {
      const sourceDirectory = await mkdtemp(join(tmpdir(), "clanky-auto-fail-"));
      const sshServer = await sshServerManager.createServer({
        name: "Failure Server",
        address: "127.0.0.1",
        username: "tester",
        repositoriesBasePath: null,
      });
      sshServerManager.setExecutorFactoryForTesting(() => ({
        async directoryExists() {
          return true;
        },
        async exec() {
          return { success: false, stdout: "", stderr: "permission denied", exitCode: 1 };
        },
        async fileExists() {
          return false;
        },
        async readFile() {
          return null;
        },
        async streamFile() {
          return null;
        },
        async listDirectory() {
          return [];
        },
        async writeFile() {
          return false;
        },
      }));

      await createWorkspace({
        id: "auto-fail-workspace",
        name: "Auto Fail Workspace",
        directory: testWorkDir,
        workspaceType: "git",
        executionTargetRevision: 1,
        executionHostBinding: {
          host: { kind: "ssh", serverId: sshServer.config.id },
          targetKey: `ssh:${sshServer.config.id}`,
          revision: 1,
        },
        serverSettings: makeServerSettings(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceDirectory,
        basePath: tmpdir(),
        repoUrl: "git@example.com:test/repo.git",
      });

      const response = await fetch(`${baseUrl}/api/workspaces/auto-fail-workspace`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteServerDirectory: true }),
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(500);
      const body = await response.json() as { message: string };
      expect(body.message).toBe("Failed to delete the auto-provisioned workspace directory");
      expect(await getWorkspace("auto-fail-workspace")).not.toBeNull();
      await rm(sourceDirectory, { recursive: true, force: true });
    });

    test("preserves workspace record when server directory existence check fails", async () => {
      const sourceDirectory = await mkdtemp(join(tmpdir(), "clanky-auto-exists-fail-"));
      const sshServer = await sshServerManager.createServer({
        name: "Existence Failure Server",
        address: "127.0.0.1",
        username: "tester",
        repositoriesBasePath: null,
      });
      sshServerManager.setExecutorFactoryForTesting(() => ({
        async directoryExists() {
          throw new Error("ssh connection lost");
        },
        async exec() {
          return { success: true, stdout: "", stderr: "", exitCode: 0 };
        },
        async fileExists() {
          return false;
        },
        async readFile() {
          return null;
        },
        async streamFile() {
          return null;
        },
        async listDirectory() {
          return [];
        },
        async writeFile() {
          return false;
        },
      }));

      await createWorkspace({
        id: "auto-exists-fail-workspace",
        name: "Auto Exists Fail Workspace",
        directory: testWorkDir,
        workspaceType: "git",
        executionTargetRevision: 1,
        executionHostBinding: {
          host: { kind: "ssh", serverId: sshServer.config.id },
          targetKey: `ssh:${sshServer.config.id}`,
          revision: 1,
        },
        serverSettings: makeServerSettings(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceDirectory,
        basePath: tmpdir(),
        repoUrl: "git@example.com:test/repo.git",
      });

      const response = await fetch(`${baseUrl}/api/workspaces/auto-exists-fail-workspace`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteServerDirectory: true }),
      });

      expect(response.status).toBe(500);
      const body = await response.json() as { message: string };
      expect(body.message).toBe("Failed to delete workspace");
      expect(await getWorkspace("auto-exists-fail-workspace")).not.toBeNull();
      await rm(sourceDirectory, { recursive: true, force: true });
    });

    test("returns invalid credential token errors for auto-provisioned server directory deletion", async () => {
      const sourceDirectory = await mkdtemp(join(tmpdir(), "clanky-auto-token-fail-"));
      const sshServer = await sshServerManager.createServer({
        name: "Credential Token Failure Server",
        address: "127.0.0.1",
        username: "tester",
        repositoriesBasePath: null,
      });

      await createWorkspace({
        id: "auto-token-fail-workspace",
        name: "Auto Token Fail Workspace",
        directory: testWorkDir,
        workspaceType: "git",
        executionTargetRevision: 1,
        executionHostBinding: {
          host: { kind: "ssh", serverId: sshServer.config.id },
          targetKey: `ssh:${sshServer.config.id}`,
          revision: 1,
        },
        serverSettings: makeServerSettings(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceDirectory,
        basePath: tmpdir(),
        repoUrl: "git@example.com:test/repo.git",
      });

      const response = await fetch(`${baseUrl}/api/workspaces/auto-token-fail-workspace`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteServerDirectory: true, credentialToken: "missing-token" }),
      });

      expect(response.status).toBe(400);
      const body = await response.json() as { error: string; message: string };
      expect(body.error).toBe("invalid_credential_token");
      expect(body.message).toContain("SSH credential token");
      expect(await getWorkspace("auto-token-fail-workspace")).not.toBeNull();
      await rm(sourceDirectory, { recursive: true, force: true });
    });

  });

  describe("POST /api/workspaces/:id/pull-latest-changes", () => {
    test("rejects pull latest for a directory workspace", async () => {
      const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Directory Pull Workspace",
          directory: testWorkDir,
          workspaceType: "directory",
          executionHost: localExecutionHost,
          serverSettings: makeServerSettings(),
        }),
      });
      expect(createResponse.status).toBe(201);
      const workspace = await createResponse.json() as { id: string };

      const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/pull-latest-changes`, {
        method: "POST",
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: "workspace_git_required",
      });
    });

    test("pulls the latest changes for the default branch", async () => {
      const repos = await createPullTestRepos();

      try {
        await Bun.write(join(repos.sourceDir, "README.md"), "# Test\nUpdated remotely\n");
        await runGit(repos.sourceDir, ["add", "README.md"]);
        await runGit(repos.sourceDir, ["commit", "-m", "Update README"]);
        await runGit(repos.sourceDir, ["push", "origin", repos.defaultBranch]);

        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Pull Test Workspace",
            directory: repos.cloneDir,
            executionHost: localExecutionHost,
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
            executionHost: localExecutionHost,
            serverSettings: makeServerSettings(),
          }),
        });
        expect(createResponse.ok).toBe(true);
        const workspace = await createResponse.json();

        await runGit(repos.cloneDir, ["checkout", "-b", "feature/test-branch"]);

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
            executionHost: localExecutionHost,
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

    test("returns a clear message when pull latest is unavailable without a remote", async () => {
      const repos = await createPullTestRepos();

      try {
        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Missing Remote Workspace",
            directory: repos.cloneDir,
            executionHost: localExecutionHost,
            serverSettings: makeServerSettings(),
          }),
        });
        expect(createResponse.ok).toBe(true);
        const workspace = await createResponse.json();

        await runGit(repos.cloneDir, ["remote", "remove", "origin"]);

        const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/pull-latest-changes`, {
          method: "POST",
        });
        expect(response.status).toBe(409);

        const data = await response.json();
        expect(data.error).toBe("no_remote");
        expect(data.message).toBe("Workspace has no git remote configured. Add an origin remote before pulling latest changes.");
        expect(data.message).not.toContain(repos.originDir);
      } finally {
        await rm(repos.originDir, { recursive: true, force: true });
        await rm(repos.sourceDir, { recursive: true, force: true });
        await rm(join(repos.cloneDir, ".."), { recursive: true, force: true });
      }
    });
  });

  describe("Task creation with workspaceId", () => {
    test("creates a task using workspaceId and touches the workspace", async () => {
      // Step 1: Create a workspace
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Task Test Workspace",
          directory: testWorkDir,
          executionHost: localExecutionHost,
          serverSettings: makeServerSettings(),
        }),
      });
      expect(workspaceResponse.ok).toBe(true);
      const workspace = await workspaceResponse.json();
      const originalUpdatedAt = workspace.updatedAt;

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Step 2: Create a task using the workspaceId (draft to avoid git operations)
      const taskResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: workspace.id,
          prompt: "Test prompt for task creation",
          name: "Test Task",
          attachments: [],
          model: testModel,
          cheapModel: { mode: "same-as-task" },
          maxIterations: null,
          maxConsecutiveErrors: 10,
          activityTimeoutSeconds: 300,
          stopPattern: "<promise>COMPLETE</promise>$",
          git: { branchPrefix: "", commitScope: "" },
          baseBranch: testDefaultBranch,
          useWorktree: true,
          clearPlanningFolder: false,
          planMode: false,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          draft: true,
        }),
      });
      expect(taskResponse.ok).toBe(true);
      const task = await taskResponse.json();

      // Verify the task was created with the workspace's directory
      expect(task.config.directory).toBe(testWorkDir);
      expect(task.config.workspaceId).toBe(workspace.id);
      expect(task.state.status).toBe("draft");

      // Step 3: Verify the workspace was touched (updatedAt should be updated)
      const updatedWorkspaceResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`);
      expect(updatedWorkspaceResponse.ok).toBe(true);
      const updatedWorkspace = await updatedWorkspaceResponse.json();
      expect(new Date(updatedWorkspace.updatedAt).getTime()).toBeGreaterThan(
        new Date(originalUpdatedAt).getTime()
      );

    });

    test("fails when creating task with non-existent workspaceId", async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "non-existent-workspace-id",
          prompt: "Test prompt",
          name: "Test Task",
          attachments: [],
          model: testModel,
          cheapModel: { mode: "same-as-task" },
          maxIterations: null,
          maxConsecutiveErrors: 10,
          activityTimeoutSeconds: 300,
          stopPattern: "<promise>COMPLETE</promise>$",
          git: { branchPrefix: "", commitScope: "" },
          baseBranch: testDefaultBranch,
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

  });

  describe("Workspace Server Settings Endpoints", () => {

    describe("PUT /api/workspaces/:id/server-settings", () => {
      test("updates workspace server settings", async () => {
        // Create a workspace
        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Update Settings Test",
            directory: testWorkDir,
            executionHost: localExecutionHost,
            serverSettings: makeServerSettings(),
          }),
        });
        const workspace = await createResponse.json();

        // Update server settings
        const newSettings = makeServerSettings("copilot");

        const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/server-settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(newSettings),
        });
        expect(response.ok).toBe(true);
        const updatedSettings = await response.json();

        expect(updatedSettings.agent.provider).toBe("copilot");

        // Verify persistence by fetching again
        const getResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/server-settings`);
        const fetchedSettings = await getResponse.json();
        expect(fetchedSettings.agent.provider).toBe("copilot");
      });

      test("does not emit a reset event when submitted server settings are unchanged", async () => {
        const { taskEventEmitter } = await import("../../src/core/event-emitter");

        const initialSettings = makeServerSettings("copilot");

        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "No-op Server Settings Update",
            directory: testWorkDir,
            executionHost: localExecutionHost,
            serverSettings: initialSettings,
          }),
        });
        const workspace = await createResponse.json();

        const events: Array<{ type: string; workspaceId?: string }> = [];
        const unsubscribe = taskEventEmitter.subscribe((event) => {
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

    describe("Workspace update with serverSettings", () => {

      test("resets connection when serverSettings are updated via PUT /api/workspaces/:id", async () => {
        // Import the event emitter to capture events
        const { taskEventEmitter } = await import("../../src/core/event-emitter");
        
        // Create a workspace
        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Workspace Settings Update Test",
            directory: testWorkDir,
            executionHost: localExecutionHost,
            serverSettings: makeServerSettings(),
          }),
        });
        const workspace = await createResponse.json();

        // Set up event listener to capture the server.reset event
        // Cast event to any since server.reset is not in the TaskEvent type union
        const events: Array<{ type: string; workspaceId?: string }> = [];
        const unsubscribe = taskEventEmitter.subscribe((event) => {
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
              serverSettings: makeServerSettings("copilot"),
            }),
          });

          expect(response.ok).toBe(true);
          const updated = await response.json();
          expect(updated.name).toBe("Updated Name");
          expect(updated.serverSettings.agent.provider).toBe("copilot");

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
        const { taskEventEmitter } = await import("../../src/core/event-emitter");
        
        // Create a workspace
        const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "No Reset Test",
            directory: testWorkDir,
            executionHost: localExecutionHost,
            serverSettings: makeServerSettings(),
          }),
        });
        const workspace = await createResponse.json();

        // Set up event listener to capture the server.reset event
        // Cast event to any since server.reset is not in the TaskEvent type union
        const events: Array<{ type: string; workspaceId?: string }> = [];
        const unsubscribe = taskEventEmitter.subscribe((event) => {
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

    });

    describe("Workspace settings isolation", () => {
      test("updating one workspace settings does not affect another workspace", async () => {
        // Create two separate git repositories
        const testWorkDir2 = await mkdtemp(join(tmpdir(), "clanky-api-workspace-test-work2-"));
        await initializeGitRepository(testWorkDir2, { initialCommit: "readme" });

        try {
          // Create workspace A with specific settings
          const settingsA = makeServerSettings("opencode");

          const createResponseA = await fetch(`${baseUrl}/api/workspaces`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "Workspace A",
              directory: testWorkDir,
              executionHost: localExecutionHost,
              serverSettings: settingsA,
            }),
          });
          expect(createResponseA.ok).toBe(true);
          const workspaceA = await createResponseA.json();

          // Create workspace B with different settings
          const settingsB = makeServerSettings("copilot");

          const createResponseB = await fetch(`${baseUrl}/api/workspaces`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "Workspace B",
              directory: testWorkDir2,
              executionHost: localExecutionHost,
              serverSettings: settingsB,
            }),
          });
          expect(createResponseB.ok).toBe(true);
          const workspaceB = await createResponseB.json();

          // Verify initial settings are different
          expect(workspaceA.serverSettings.agent.provider).toBe("opencode");
          expect(workspaceB.serverSettings.agent.provider).toBe("copilot");

          // Update workspace A's settings
          const newSettingsA = makeServerSettings("copilot");

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
          expect(updatedA.serverSettings.agent.provider).toBe("copilot");

          // CRITICAL: Verify workspace B was NOT affected
          const getResponseB = await fetch(`${baseUrl}/api/workspaces/${workspaceB.id}`);
          expect(getResponseB.ok).toBe(true);
          const unchangedB = await getResponseB.json();
          expect(unchangedB.serverSettings.agent.provider).toBe("copilot");

          // Also verify via the list endpoint
          const listResponse = await fetch(`${baseUrl}/api/workspaces`);
          expect(listResponse.ok).toBe(true);
          const workspaces = await listResponse.json();
          
          const listedA = workspaces.find((w: { id: string }) => w.id === workspaceA.id);
          const listedB = workspaces.find((w: { id: string }) => w.id === workspaceB.id);

          expect(listedA.serverSettings.agent.provider).toBe("copilot");
          expect(listedB.serverSettings.agent.provider).toBe("copilot");
        } finally {
          // Cleanup the second test directory
          await rm(testWorkDir2, { recursive: true, force: true });
        }
      });
    });
  });

  describe("POST /api/workspaces/:id/archived-tasks/purge", () => {
    test("purges only archived tasks for the selected workspace", async () => {
      // Purging is destructive, so this asserts the selection rule against real
      // persisted tasks: only archived (deleted) tasks, and only in the requested
      // workspace, may be removed.
      async function createDraftTask(workspaceId: string, name: string): Promise<string> {
        const response = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            prompt: "Purge selection fixture",
            name,
            attachments: [],
            model: testModel,
            cheapModel: { mode: "same-as-task" },
            maxIterations: null,
            maxConsecutiveErrors: 10,
            activityTimeoutSeconds: 300,
            stopPattern: "<promise>COMPLETE</promise>$",
            git: { branchPrefix: "", commitScope: "" },
            baseBranch: testDefaultBranch,
            useWorktree: true,
            clearPlanningFolder: false,
            planMode: false,
            autoAcceptPlan: false,
            fullyAutonomous: false,
            draft: true,
          }),
        });
        expect(response.status).toBe(201);
        return (await response.json()).config.id;
      }

      async function createWorkspaceNamed(name: string): Promise<string> {
        const response = await fetch(`${baseUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            directory: testWorkDir,
            executionHost: localExecutionHost,
            serverSettings: makeServerSettings(),
          }),
        });
        expect(response.ok).toBe(true);
        return (await response.json()).id;
      }

      const targetWorkspaceId = await createWorkspaceNamed("Bulk Purge Workspace");
      const otherWorkspaceId = await createWorkspaceNamed("Bulk Purge Other Workspace");

      const archivedInTarget = await createDraftTask(targetWorkspaceId, "Archived In Target");
      const liveInTarget = await createDraftTask(targetWorkspaceId, "Live In Target");
      const archivedInOther = await createDraftTask(otherWorkspaceId, "Archived In Other");

      for (const taskId of [archivedInTarget, archivedInOther]) {
        const deleteResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`, { method: "DELETE" });
        expect(deleteResponse.ok).toBe(true);
      }

      const response = await fetch(`${baseUrl}/api/workspaces/${targetWorkspaceId}/archived-tasks/purge`, {
        method: "POST",
      });
      expect(response.ok).toBe(true);
      const body = await response.json();

      expect(body.success).toBe(true);
      expect(body.workspaceId).toBe(targetWorkspaceId);
      expect(body.purgedTaskIds).toEqual([archivedInTarget]);
      expect(body.purgedCount).toBe(1);
      expect(body.failures).toEqual([]);

      expect((await fetch(`${baseUrl}/api/tasks/${archivedInTarget}`)).status).toBe(404);
      expect((await fetch(`${baseUrl}/api/tasks/${liveInTarget}`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/api/tasks/${archivedInOther}`)).status).toBe(200);
    });

    test("returns 404 for a missing workspace", async () => {
      const response = await fetch(`${baseUrl}/api/workspaces/non-existent-id/archived-tasks/purge`, {
        method: "POST",
      });

      expect(response.status).toBe(404);
    });
  });

});
