import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { AcpBackend } from "../../src/backends/acp";
import { backendManager } from "../../src/core/backend-manager";
import { closeDatabase, ensureDataDirectories } from "../../src/persistence/database";
import { createWorkspace } from "../../src/persistence/workspaces";
import { getDefaultServerSettings, type ServerSettings } from "../../src/types/settings";

interface WorkspaceConnectionStateLike {
  backend: AcpBackend;
  settings: ServerSettings;
  connectionError: string | null;
}

interface BackendManagerInternals {
  connections: Map<string, WorkspaceConnectionStateLike>;
  commandExecutors: Map<string, unknown>;
}

interface CommandExecutorInternals {
  provider: "local" | "ssh";
  host?: string;
  port: number;
  user?: string;
}

describe("BackendManager workspace state hydration", () => {
  let testDataDir: string;

  beforeEach(async () => {
    testDataDir = await mkdtemp(join(tmpdir(), "ralpher-backend-manager-state-"));
    process.env["RALPHER_DATA_DIR"] = testDataDir;
    backendManager.resetForTesting();
    await ensureDataDirectories();
  });

  afterEach(async () => {
    backendManager.resetForTesting();
    closeDatabase();
    delete process.env["RALPHER_DATA_DIR"];
    await rm(testDataDir, { recursive: true, force: true });
  });

  async function createSshWorkspace(): Promise<void> {
    await createWorkspace({
      id: "workspace-ssh",
      name: "SSH Workspace",
      directory: "/workspaces/project",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      serverSettings: {
        agent: {
          provider: "copilot",
          transport: "ssh",
          hostname: "remote.example.com",
          port: 2222,
          username: "alice",
          password: "secret",
        },
      },
    });
  }

  test("getBackend does not seed a default local state for uninitialized workspaces", async () => {
    await createSshWorkspace();

    expect(() => backendManager.getBackend("workspace-ssh")).toThrow(
      /Use getBackendAsync\(\) or connect\(\) first/,
    );

    const internals = backendManager as unknown as BackendManagerInternals;
    expect(internals.connections.has("workspace-ssh")).toBe(false);
  });

  test("getInitializedBackend returns null for uninitialized workspaces without seeding state", async () => {
    await createSshWorkspace();

    expect(backendManager.getInitializedBackend("workspace-ssh")).toBeNull();

    const internals = backendManager as unknown as BackendManagerInternals;
    expect(internals.connections.has("workspace-ssh")).toBe(false);
  });

  test("getCommandExecutorAsync hydrates SSH settings for an uninitialized workspace", async () => {
    await createSshWorkspace();

    const executor = await backendManager.getCommandExecutorAsync("workspace-ssh", "/workspaces/project");
    const executorInternals = executor as unknown as CommandExecutorInternals;

    expect(executorInternals.provider).toBe("ssh");
    expect(executorInternals.host).toBe("remote.example.com");
    expect(executorInternals.port).toBe(2222);
    expect(executorInternals.user).toBe("alice");
  });

  test("getCommandExecutorAsync reuses one executor for concurrent workspace file requests", async () => {
    await createSshWorkspace();

    const [firstExecutor, secondExecutor, thirdExecutor] = await Promise.all([
      backendManager.getCommandExecutorAsync("workspace-ssh", "/workspaces/project"),
      backendManager.getCommandExecutorAsync("workspace-ssh", "/workspaces/project"),
      backendManager.getCommandExecutorAsync("workspace-ssh", "/workspaces/project"),
    ]);

    const internals = backendManager as unknown as BackendManagerInternals;
    expect(firstExecutor).toBe(secondExecutor);
    expect(secondExecutor).toBe(thirdExecutor);
    expect(internals.commandExecutors.size).toBe(1);
  });

  test("getCommandExecutorAsync keeps separate queues for different workspace directories", async () => {
    await createSshWorkspace();

    const workspaceExecutor = await backendManager.getCommandExecutorAsync("workspace-ssh", "/workspaces/project");
    const worktreeExecutor = await backendManager.getCommandExecutorAsync("workspace-ssh", "/workspaces/project-worktree");

    expect(workspaceExecutor).not.toBe(worktreeExecutor);
  });

  test("resetWorkspaceConnection clears cached executors when test backend mode preserves state", async () => {
    await createSshWorkspace();
    await backendManager.getCommandExecutorAsync("workspace-ssh", "/workspaces/project");
    backendManager.setBackendForTesting(new AcpBackend());

    await backendManager.resetWorkspaceConnection("workspace-ssh");

    const internals = backendManager as unknown as BackendManagerInternals;
    expect(internals.commandExecutors.size).toBe(0);
  });

  test("getCommandExecutorAsync refreshes stale default state to persisted SSH settings", async () => {
    await createSshWorkspace();

    const internals = backendManager as unknown as BackendManagerInternals;
    internals.connections.set("workspace-ssh", {
      backend: new AcpBackend(),
      settings: getDefaultServerSettings(),
      connectionError: null,
    });

    const executor = await backendManager.getCommandExecutorAsync("workspace-ssh", "/workspaces/project");
    const executorInternals = executor as unknown as CommandExecutorInternals;
    const state = internals.connections.get("workspace-ssh");

    expect(executorInternals.provider).toBe("ssh");
    expect(executorInternals.host).toBe("remote.example.com");
    expect(executorInternals.port).toBe(2222);
    expect(executorInternals.user).toBe("alice");
    expect(state?.settings.agent.transport).toBe("ssh");
  });
});
