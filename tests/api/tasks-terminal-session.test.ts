import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { type Server } from "bun";
import { serveNativeApiRoutes } from "../native-api-server";
import { closeDatabase, getDatabase, initializeDatabase } from "../../src/persistence/database";
import { backendManager } from "../../src/core/backend-manager";
import { sshServerManager } from "../../src/core/ssh-server-manager";
import { taskManager } from "../../src/core/task-manager";
import { createMockBackend } from "../mocks/mock-backend";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { getCurrentBranch, initializeGitRepository } from "../helpers/git-fixtures";
import { pollUntil } from "../helpers/polling";
import type { TerminalSession } from "../../src/shared";

class TaskTerminalExecutor extends TestCommandExecutor {
  public deleteCommands: string[] = [];

  override async exec(command: string, args: string[], options?: Parameters<TestCommandExecutor["exec"]>[2]) {
    if (command === "bash" && args[0] === "-lc" && args[1]?.includes("command -v dtach")) {
      return {
        success: true,
        stdout: "dtach - version 0.9\n",
        stderr: "",
        exitCode: 0,
      };
    }
    if (command === "bash" && args[0] === "-lc" && args[1]?.includes(".dtach.sock")) {
      this.deleteCommands.push(args[1]);
      return {
        success: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
      };
    }
    return await super.exec(command, args, options);
  }
}

describe("Task terminal session API integration", () => {
  let dataDir: string;
  let workDir: string;
  let server: Server<unknown>;
  let baseUrl: string;
  let executor: TaskTerminalExecutor;
  let defaultBranch = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clanky-task-terminal-data-"));
    process.env["CLANKY_DATA_DIR"] = dataDir;

    await initializeDatabase();

    backendManager.setBackendForTesting(createMockBackend());
    executor = new TaskTerminalExecutor();
    backendManager.setExecutorFactoryForTesting(() => executor);

    server = serveNativeApiRoutes();
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    server.stop();
    taskManager.resetForTesting();
    backendManager.resetForTesting();
    closeDatabase();
    await rm(dataDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
    delete process.env["CLANKY_DATA_DIR"];
  });

  beforeEach(() => {
    taskManager.resetForTesting();
    const db = getDatabase();
    db.run("DELETE FROM preview_sessions");
    db.run("DELETE FROM terminal_sessions");
    db.run("DELETE FROM tasks WHERE workspace_id IS NOT NULL");
    db.run("DELETE FROM workspaces");
    db.run("DELETE FROM ssh_servers");
    executor.deleteCommands = [];
  });

  afterEach(async () => {
    taskManager.resetForTesting();
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
      workDir = "";
    }
  });

  async function createGitRepo(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "clanky-task-terminal-work-"));
    await initializeGitRepository(directory, { initialCommit: "readme" });
    defaultBranch = await getCurrentBranch(directory);
    return directory;
  }

  async function createWorkspace(transport: "ssh" | "stdio") {
    workDir = await createGitRepo();
    const executionHost = transport === "ssh"
      ? {
          kind: "ssh" as const,
          serverId: (await sshServerManager.createServer({
            name: "Task SSH server",
            address: "localhost",
            username: "tester",
            repositoriesBasePath: null,
          })).config.id,
        }
      : (await (await fetch(`${baseUrl}/api/execution-hosts`)).json() as Array<{
          ref: { kind: string; nodeId?: string };
        }>).find((host) => host.ref.kind === "local")!.ref;
    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `${transport.toUpperCase()} Workspace`,
        directory: workDir,
        executionHost,
        serverSettings: {
          agent: {
            provider: "opencode",
          },
        },
      }),
    });
    expect(response.ok).toBe(true);
    return await response.json() as { id: string };
  }

  async function createTask(workspaceId: string) {
    const response = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        prompt: "Create a linked terminal session",
        name: "Test Task",
        attachments: [],
        model: {
          providerID: "test-provider",
          modelID: "test-model",
          variant: "",
        },
        cheapModel: { mode: "same-as-task" },
        maxIterations: null,
        maxConsecutiveErrors: 10,
        activityTimeoutSeconds: 300,
        stopPattern: "<promise>COMPLETE</promise>$",
        git: {
          branchPrefix: "",
          commitScope: "",
        },
        baseBranch: defaultBranch,
        useWorktree: true,
        clearPlanningFolder: false,
        planMode: true,
        autoAcceptPlan: false,
        fullyAutonomous: false,
        draft: false,
      }),
    });
    expect(response.status).toBe(201);
    return await response.json() as {
      config: { id: string; directory: string };
      state: { git?: { worktreePath?: string } };
    };
  }

  async function waitForTaskWorktree(taskId: string): Promise<string> {
    const observation = await pollUntil(
      async () => {
        const response = await fetch(`${baseUrl}/api/tasks/${taskId}`);
        if (!response.ok) {
          return { path: null, status: `HTTP ${response.status}` };
        }
        const task = await response.json() as {
          config: { directory: string; useWorktree?: boolean };
          state: { git?: { worktreePath?: string } };
        };
        return {
          path: task.state.git?.worktreePath ?? (task.config.useWorktree ? null : task.config.directory),
          status: task.state.git?.worktreePath ? "worktree-ready" : "pending",
        };
      },
      (value) => value.path !== null,
      {
        description: `worktree path for task ${taskId}`,
        timeoutMs: 5000,
        formatLastObserved: (value) => `${value.status}; path=${value.path ?? "none"}`,
      },
    );
    if (observation.path === null) {
      throw new Error(`Task ${taskId} returned no worktree path after polling`);
    }
    return observation.path;
  }

  test("creates and reconnects to the same linked terminal session", async () => {
    const workspace = await createWorkspace("ssh");
    const task = await createTask(workspace.id);
    const worktreePath = await waitForTaskWorktree(task.config.id);

    const firstResponse = await fetch(`${baseUrl}/api/tasks/${task.config.id}/terminal-session`, {
      method: "POST",
    });
    expect(firstResponse.ok).toBe(true);
    const firstSession = await firstResponse.json() as TerminalSession;

    const secondResponse = await fetch(`${baseUrl}/api/tasks/${task.config.id}/terminal-session`, {
      method: "POST",
    });
    expect(secondResponse.ok).toBe(true);
    const secondSession = await secondResponse.json() as {
      config: { id: string };
    };

    const getResponse = await fetch(`${baseUrl}/api/tasks/${task.config.id}/terminal-session`);
    expect(getResponse.ok).toBe(true);
    const fetchedSession = await getResponse.json() as {
      config: { id: string };
    };

    expect(firstSession.config.taskId).toBe(task.config.id);
    expect(firstSession.config.directory).toBe(worktreePath);
    expect(secondSession.config.id).toBe(firstSession.config.id);
    expect(fetchedSession.config.id).toBe(firstSession.config.id);
    expect(firstSession.config.executionHostBinding.host.kind).toBe("ssh");
  });

  test("creates a linked terminal session for stdio workspaces", async () => {
    const workspace = await createWorkspace("stdio");
    const task = await createTask(workspace.id);

    const response = await fetch(`${baseUrl}/api/tasks/${task.config.id}/terminal-session`, {
      method: "POST",
    });

    expect(response.ok).toBe(true);
    const session = await response.json() as {
      config: {
        taskId?: string;
        executionHostBinding: { host: { kind: string } };
      };
    };
    expect(session.config.taskId).toBe(task.config.id);
    expect(session.config.executionHostBinding.host.kind).toBe("local");
  });

  test("purging a task deletes its linked terminal session", async () => {
    const workspace = await createWorkspace("ssh");
    const task = await createTask(workspace.id);
    await waitForTaskWorktree(task.config.id);

    const sessionResponse = await fetch(`${baseUrl}/api/tasks/${task.config.id}/terminal-session`, {
      method: "POST",
    });
    expect(sessionResponse.ok).toBe(true);
    const session = await sessionResponse.json() as {
      config: { id: string; remoteSessionName: string };
    };

    const discardResponse = await fetch(`${baseUrl}/api/tasks/${task.config.id}/discard`, {
      method: "POST",
    });
    expect(discardResponse.ok).toBe(true);

    const purgeResponse = await fetch(`${baseUrl}/api/tasks/${task.config.id}/purge`, {
      method: "POST",
    });
    expect(purgeResponse.ok).toBe(true);

    const getSessionResponse = await fetch(`${baseUrl}/api/terminal-sessions/${session.config.id}`);
    expect(getSessionResponse.status).toBe(404);
    expect(executor.deleteCommands.some((command) => command.includes(session.config.remoteSessionName))).toBe(true);
  });

  test("enforces per-user task uniqueness for terminal sessions", async () => {
    const workspace = await createWorkspace("ssh");
    const task = await createTask(workspace.id);
    await waitForTaskWorktree(task.config.id);

    const firstResponse = await fetch(`${baseUrl}/api/tasks/${task.config.id}/terminal-session`, {
      method: "POST",
    });
    expect(firstResponse.ok).toBe(true);
    const firstSession = await firstResponse.json() as TerminalSession;

    const secondResponse = await fetch(`${baseUrl}/api/tasks/${task.config.id}/terminal-session`, {
      method: "POST",
    });
    expect(secondResponse.ok).toBe(true);
    const secondSession = await secondResponse.json() as TerminalSession;

    expect(secondSession.config.id).toBe(firstSession.config.id);
  });

  test("returns 404 for terminal session on non-existent task", async () => {
    const getResponse = await fetch(`${baseUrl}/api/tasks/fake-task-id/terminal-session`);
    expect(getResponse.status).toBe(404);

    const postResponse = await fetch(`${baseUrl}/api/tasks/fake-task-id/terminal-session`, {
      method: "POST",
    });
    expect(postResponse.status).toBe(404);
  });
});
