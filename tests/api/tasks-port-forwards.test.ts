import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { serve, type Server } from "bun";
import { spawn } from "node:child_process";
import { apiRoutes } from "../../src/api";
import { portForwardProxyRoutes } from "../../src/api/port-forwards";
import { websocketHandlers } from "../../src/api/websocket";
import { ensureDataDirectories, getDatabase } from "../../src/persistence/database";
import { backendManager } from "../../src/core/backend-manager";
import { createMockBackend } from "../mocks/mock-backend";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { portForwardManager } from "../../src/core/port-forward-manager";

class TaskPortForwardExecutor extends TestCommandExecutor {
  override async exec(command: string, args: string[], options?: Parameters<TestCommandExecutor["exec"]>[2]) {
    if (command === "bash" && args[0] === "-lc" && args[1]?.includes("command -v dtach")) {
      return {
        success: true,
        stdout: "dtach - version 0.9\n",
        stderr: "",
        exitCode: 0,
      };
    }
    return await super.exec(command, args, options);
  }
}

describe("Task port forwards API integration", () => {
  let dataDir: string;
  let workDir: string;
  let server: Server<unknown>;
  let baseUrl: string;
  let forwardedAppServer: Server<unknown> | null = null;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clanky-task-port-forward-data-"));
    process.env["CLANKY_DATA_DIR"] = dataDir;

    await ensureDataDirectories();

    backendManager.setBackendForTesting(createMockBackend());
    backendManager.setExecutorFactoryForTesting(() => new TaskPortForwardExecutor());
    portForwardManager.setSpawnFactoryForTesting(() => spawn("sleep", ["60"], { stdio: "ignore" }));

    server = serve({
      port: 0,
      routes: {
        ...apiRoutes,
        ...portForwardProxyRoutes,
      },
      websocket: websocketHandlers,
    });
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    forwardedAppServer?.stop();
    server.stop();
    backendManager.resetForTesting();
    portForwardManager.setSpawnFactoryForTesting(null);
    await rm(dataDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
    delete process.env["CLANKY_DATA_DIR"];
  });

  beforeEach(async () => {
    forwardedAppServer?.stop();
    forwardedAppServer = null;
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
    workDir = await createGitRepo();
    const db = getDatabase();
    db.run("DELETE FROM forwarded_ports");
    db.run("DELETE FROM ssh_sessions");
    db.run("DELETE FROM tasks WHERE workspace_id IS NOT NULL");
    db.run("DELETE FROM workspaces");
  });

  async function createGitRepo(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "clanky-task-port-forward-work-"));
    await Bun.$`git init -b main ${directory}`.quiet();
    await Bun.$`git -C ${directory} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${directory} config user.name "Test User"`.quiet();
    await Bun.$`touch ${directory}/README.md`.quiet();
    await Bun.$`git -C ${directory} add .`.quiet();
    await Bun.$`git -C ${directory} commit -m "Initial commit"`.quiet();
    return directory;
  }

  async function createWorkspace() {
    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "SSH Workspace",
        directory: workDir,
        serverSettings: {
          agent: {
            provider: "opencode",
            transport: "ssh",
            hostname: "workspace.example.com",
            username: "tester",
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
        prompt: "Create a forwarded port",
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
    return await response.json() as { config: { id: string } };
  }

  async function deleteForward(taskId: string, forwardId: string): Promise<void> {
    const response = await fetch(`${baseUrl}/api/tasks/${taskId}/port-forwards/${forwardId}`, {
      method: "DELETE",
    });
    expect([200, 404]).toContain(response.status);
  }

  test("creates, lists, and deletes task port forwards", async () => {
    const workspace = await createWorkspace();
    const task = await createTask(workspace.id);

    const createResponse = await fetch(`${baseUrl}/api/tasks/${task.config.id}/port-forwards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        remotePort: 3000,
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as {
      config: { id: string; remoteHost: string; remotePort: number };
      state: { status: string };
    };
    expect(created.config.remoteHost).toBe("localhost");
    expect(created.config.remotePort).toBe(3000);
    expect(created.state.status).toBe("active");

    const listResponse = await fetch(`${baseUrl}/api/tasks/${task.config.id}/port-forwards`);
    expect(listResponse.ok).toBe(true);
    const forwards = await listResponse.json() as Array<{ config: { id: string } }>;
    expect(forwards).toHaveLength(1);
    expect(forwards[0]?.config.id).toBe(created.config.id);

    const deleteResponse = await fetch(`${baseUrl}/api/tasks/${task.config.id}/port-forwards/${created.config.id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.ok).toBe(true);

    const listAfterDelete = await fetch(`${baseUrl}/api/tasks/${task.config.id}/port-forwards`);
    expect(await listAfterDelete.json()).toEqual([]);
  });

  test("proxies forwarded browser traffic through the task URL", async () => {
    const workspace = await createWorkspace();
    const task = await createTask(workspace.id);
    let forwardId: string | undefined;

    try {
      const createResponse = await fetch(`${baseUrl}/api/tasks/${task.config.id}/port-forwards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remotePort: 3000,
        }),
      });
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json() as {
        config: { id: string; localPort: number };
      };
      forwardId = created.config.id;

      forwardedAppServer = serve({
        port: created.config.localPort,
        routes: {
          "/": new Response("<html><head></head><body><script src=\"/app.js\"></script></body></html>", {
            headers: { "Content-Type": "text/html" },
          }),
          "/app.js": new Response("console.log('proxied');", {
            headers: { "Content-Type": "application/javascript" },
          }),
        },
      });

      const proxyResponse = await fetch(`${baseUrl}/task/${task.config.id}/port/${created.config.id}/`);
      expect(proxyResponse.ok).toBe(true);
      const html = await proxyResponse.text();
      expect(html).toContain(`/task/${task.config.id}/port/${created.config.id}/app.js`);

      const jsResponse = await fetch(`${baseUrl}/task/${task.config.id}/port/${created.config.id}/app.js`);
      expect(jsResponse.ok).toBe(true);
      expect(await jsResponse.text()).toContain("proxied");
    } finally {
      forwardedAppServer?.stop();
      forwardedAppServer = null;
      if (forwardId) {
        await deleteForward(task.config.id, forwardId);
      }
    }
  });

  test("redirects base proxy routes with trailing slash while preserving query strings", async () => {
    const response = await fetch(`${baseUrl}/task/test-task/port/test-forward?asset=1`, {
      redirect: "manual",
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${baseUrl}/task/test-task/port/test-forward/?asset=1`);
  });

  test("rewrites localhost redirect locations back into the task proxy route", async () => {
    const workspace = await createWorkspace();
    const task = await createTask(workspace.id);
    let forwardId: string | undefined;

    try {
      const createResponse = await fetch(`${baseUrl}/api/tasks/${task.config.id}/port-forwards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remotePort: 3000,
        }),
      });
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json() as {
        config: { id: string; localPort: number };
      };
      forwardId = created.config.id;

      forwardedAppServer = serve({
        port: created.config.localPort,
        routes: {
          "/": Response.redirect(`http://localhost:${String(created.config.localPort)}/dashboard?asset=1#hash`, 302),
        },
      });

      const proxyResponse = await fetch(`${baseUrl}/task/${task.config.id}/port/${created.config.id}/`, {
        redirect: "manual",
      });

      expect(proxyResponse.status).toBe(302);
      expect(proxyResponse.headers.get("location")).toBe(
        `/task/${task.config.id}/port/${created.config.id}/dashboard?asset=1#hash`,
      );
    } finally {
      forwardedAppServer?.stop();
      forwardedAppServer = null;
      if (forwardId) {
        await deleteForward(task.config.id, forwardId);
      }
    }
  });

  test("uses localhost for the forwarded destination and ignores remoteHost in the request body", async () => {
    const workspace = await createWorkspace();
    const task = await createTask(workspace.id);

    const createResponse = await fetch(`${baseUrl}/api/tasks/${task.config.id}/port-forwards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        remoteHost: "ignored.example.com",
        remotePort: 3000,
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as {
      config: { remoteHost: string; remotePort: number };
    };

    expect(created.config.remoteHost).toBe("localhost");
    expect(created.config.remotePort).toBe(3000);
  });

  test("rejects duplicate forwarded ports for the same workspace port", async () => {
    const workspace = await createWorkspace();
    const task = await createTask(workspace.id);
    let forwardId: string | undefined;

    try {
      const firstResponse = await fetch(`${baseUrl}/api/tasks/${task.config.id}/port-forwards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remotePort: 3000,
        }),
      });
      expect(firstResponse.status).toBe(201);
      const firstForward = await firstResponse.json() as {
        config: { id: string };
      };
      forwardId = firstForward.config.id;

      const duplicateResponse = await fetch(`${baseUrl}/api/tasks/${task.config.id}/port-forwards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remotePort: 3000,
        }),
      });
      expect(duplicateResponse.status).toBe(409);
      expect(await duplicateResponse.json()).toEqual({
        error: "duplicate_port_forward",
        message: "Port 3000 is already being forwarded for this workspace",
      });
    } finally {
      if (forwardId) {
        await deleteForward(task.config.id, forwardId);
      }
    }
  });
});
