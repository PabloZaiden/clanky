import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { type Server } from "bun";
import { serveNativeApiRoutes } from "../native-api-server";
import { closeDatabase, ensureDataDirectories, getDatabase } from "../../src/persistence/database";
import { backendManager } from "../../src/core/backend-manager";
import { taskManager } from "../../src/core/task-manager";
import { createMockBackend } from "../mocks/mock-backend";
import { TestCommandExecutor } from "../mocks/mock-executor";

class TaskSshExecutor extends TestCommandExecutor {
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

describe("Task SSH session API integration", () => {
  let dataDir: string;
  let workDir: string;
  let server: Server<unknown>;
  let baseUrl: string;
  let executor: TaskSshExecutor;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clanky-task-ssh-data-"));
    process.env["CLANKY_DATA_DIR"] = dataDir;

    await ensureDataDirectories();

    backendManager.setBackendForTesting(createMockBackend());
    executor = new TaskSshExecutor();
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
    db.run("DELETE FROM ssh_sessions");
    db.run("DELETE FROM tasks WHERE workspace_id IS NOT NULL");
    db.run("DELETE FROM workspaces");
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
    const directory = await mkdtemp(join(tmpdir(), "clanky-task-ssh-work-"));
    await Bun.$`git init -b main ${directory}`.quiet();
    await Bun.$`git -C ${directory} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${directory} config user.name "Test User"`.quiet();
    await Bun.$`touch ${directory}/README.md`.quiet();
    await Bun.$`git -C ${directory} add .`.quiet();
    await Bun.$`git -C ${directory} commit -m "Initial commit"`.quiet();
    return directory;
  }

  async function createWorkspace(transport: "ssh" | "stdio") {
    workDir = await createGitRepo();
    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `${transport.toUpperCase()} Workspace`,
        directory: workDir,
        serverSettings: transport === "ssh"
          ? {
              agent: {
                provider: "opencode",
                transport: "ssh",
                hostname: "localhost",
                username: "tester",
              },
            }
          : {
              agent: {
                provider: "opencode",
                transport: "stdio",
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
        prompt: "Create a linked ssh session",
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
        baseBranch: "main",
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
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const response = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      if (response.ok) {
        const task = await response.json() as {
          config: { directory: string; useWorktree?: boolean };
          state: { git?: { worktreePath?: string } };
        };
        if (task.state.git?.worktreePath) {
          return task.state.git.worktreePath;
        }
        if (!task.config.useWorktree) {
          return task.config.directory;
        }
      }
      await Bun.sleep(50);
    }
    throw new Error(`Timed out waiting for worktree path for task ${taskId}`);
  }

  test("creates and reconnects to the same linked SSH session", async () => {
    const workspace = await createWorkspace("ssh");
    const task = await createTask(workspace.id);
    const worktreePath = await waitForTaskWorktree(task.config.id);

    const firstResponse = await fetch(`${baseUrl}/api/tasks/${task.config.id}/ssh-session`, {
      method: "POST",
    });
    expect(firstResponse.ok).toBe(true);
    const firstSession = await firstResponse.json() as {
      config: { id: string; taskId?: string; directory: string };
    };

    const secondResponse = await fetch(`${baseUrl}/api/tasks/${task.config.id}/ssh-session`, {
      method: "POST",
    });
    expect(secondResponse.ok).toBe(true);
    const secondSession = await secondResponse.json() as {
      config: { id: string };
    };

    const getResponse = await fetch(`${baseUrl}/api/tasks/${task.config.id}/ssh-session`);
    expect(getResponse.ok).toBe(true);
    const fetchedSession = await getResponse.json() as {
      config: { id: string };
    };

    expect(firstSession.config.taskId).toBe(task.config.id);
    expect(firstSession.config.directory).toBe(worktreePath);
    expect(secondSession.config.id).toBe(firstSession.config.id);
    expect(fetchedSession.config.id).toBe(firstSession.config.id);
  });

  test("rejects linked SSH sessions for stdio workspaces", async () => {
    const workspace = await createWorkspace("stdio");
    const task = await createTask(workspace.id);

    const response = await fetch(`${baseUrl}/api/tasks/${task.config.id}/ssh-session`, {
      method: "POST",
    });

    expect(response.status).toBe(400);
    const data = await response.json() as { error: string; message: string };
    expect(data.error).toBe("invalid_session_configuration");
    expect(data.message).toContain("ssh transport");
  });

  test("purging a task deletes its linked SSH session", async () => {
    const workspace = await createWorkspace("ssh");
    const task = await createTask(workspace.id);
    await waitForTaskWorktree(task.config.id);

    const sessionResponse = await fetch(`${baseUrl}/api/tasks/${task.config.id}/ssh-session`, {
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

    const getSessionResponse = await fetch(`${baseUrl}/api/ssh-sessions/${session.config.id}`);
    expect(getSessionResponse.status).toBe(404);
    expect(executor.deleteCommands.some((command) => command.includes(session.config.remoteSessionName))).toBe(true);
  });
});
