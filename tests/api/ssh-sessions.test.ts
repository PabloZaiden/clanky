import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ensureDataDirectories, getDatabase } from "../../src/persistence/database";
import { backendManager } from "../../src/core/backend-manager";
import { createMockBackend } from "../mocks/mock-backend";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { type Server } from "bun";
import { serveNativeApiRoutes } from "../native-api-server";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";

class SshSessionTestExecutor extends TestCommandExecutor {
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

class MissingDtachExecutor extends SshSessionTestExecutor {
  override async exec(command: string, args: string[], options?: Parameters<TestCommandExecutor["exec"]>[2]) {
    if (command === "bash" && args[0] === "-lc" && args[1]?.includes("command -v dtach")) {
      return {
        success: false,
        stdout: "",
        stderr: "dtach missing",
        exitCode: 127,
      };
    }
    return await super.exec(command, args, options);
  }
}

class FailingPersistentCleanupExecutor extends SshSessionTestExecutor {
  override async exec(command: string, args: string[], options?: Parameters<TestCommandExecutor["exec"]>[2]) {
    if (command === "bash" && args[0] === "-lc" && args[1]?.includes(".dtach.sock")) {
      return {
        success: false,
        stdout: "",
        stderr: "Failed to stop remote persistent SSH session",
        exitCode: 1,
      };
    }
    return await super.exec(command, args, options);
  }
}

describe("SSH sessions API integration", () => {
  let dataDir: string;
  let workDir: string;
  let server: Server<unknown>;
  let baseUrl: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clanky-ssh-sessions-data-"));
    workDir = await mkdtemp(join(tmpdir(), "clanky-ssh-sessions-work-"));
    process.env["CLANKY_DATA_DIR"] = dataDir;

    await ensureDataDirectories();
    await Bun.$`git init ${workDir}`.quiet();
    await Bun.$`git -C ${workDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${workDir} config user.name "Test User"`.quiet();
    await Bun.$`touch ${workDir}/README.md`.quiet();
    await Bun.$`git -C ${workDir} add .`.quiet();
    await Bun.$`git -C ${workDir} commit -m "Initial commit"`.quiet();

    backendManager.setBackendForTesting(createMockBackend());
    backendManager.setExecutorFactoryForTesting(() => new SshSessionTestExecutor());

    server = serveNativeApiRoutes();
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    server.stop();
    backendManager.resetForTesting();
    await rm(dataDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
    delete process.env["CLANKY_DATA_DIR"];
  });

  beforeEach(() => {
    const db = getDatabase();
    db.run("DELETE FROM ssh_sessions");
    db.run("DELETE FROM tasks WHERE workspace_id IS NOT NULL");
    db.run("DELETE FROM workspaces");
    backendManager.setExecutorFactoryForTesting(() => new SshSessionTestExecutor());
  });

  async function createWorkspace(options: {
    transport?: "ssh" | "stdio";
    name?: string;
    directory?: string;
  } = {}) {
    const transport = options.transport ?? "ssh";
    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: options.name ?? "SSH Workspace",
        directory: options.directory ?? workDir,
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

  test("creates, lists, fetches, and deletes an SSH session", async () => {
    const workspace = await createWorkspace({ transport: "ssh" });

    const createResponse = await fetch(`${baseUrl}/api/ssh-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        name: "My SSH Session",
        connectionMode: "dtach",
        useTmux: false,
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { config: { id: string; name: string; useTmux: boolean } };
    expect(created.config.name).toBe("My SSH Session");
    expect(created.config.useTmux).toBe(false);

    const listResponse = await fetch(`${baseUrl}/api/ssh-sessions`);
    expect(listResponse.ok).toBe(true);
    const sessions = await listResponse.json() as Array<{ config: { id: string } }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.config.id).toBe(created.config.id);

    const getResponse = await fetch(`${baseUrl}/api/ssh-sessions/${created.config.id}`);
    expect(getResponse.ok).toBe(true);
    const fetched = await getResponse.json() as { config: { remoteSessionName: string; useTmux: boolean } };
    expect(fetched.config.remoteSessionName).toContain("clanky-");
    expect(fetched.config.useTmux).toBe(false);

    const deleteResponse = await fetch(`${baseUrl}/api/ssh-sessions/${created.config.id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.ok).toBe(true);

    const listAfterDelete = await fetch(`${baseUrl}/api/ssh-sessions`);
    expect(listAfterDelete.ok).toBe(true);
    expect(await listAfterDelete.json()).toEqual([]);
  });

  test("renames an existing SSH session", async () => {
    const workspace = await createWorkspace({ transport: "ssh" });

    const createResponse = await fetch(`${baseUrl}/api/ssh-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        name: "Original SSH Session",
        connectionMode: "dtach",
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { config: { id: string; name: string } };

    const renameResponse = await fetch(`${baseUrl}/api/ssh-sessions/${created.config.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Renamed SSH Session",
      }),
    });

    expect(renameResponse.ok).toBe(true);
    const renamed = await renameResponse.json() as { config: { id: string; name: string } };
    expect(renamed.config.id).toBe(created.config.id);
    expect(renamed.config.name).toBe("Renamed SSH Session");

    const getResponse = await fetch(`${baseUrl}/api/ssh-sessions/${created.config.id}`);
    expect(getResponse.ok).toBe(true);
    const fetched = await getResponse.json() as { config: { name: string } };
    expect(fetched.config.name).toBe("Renamed SSH Session");
  });

  test("rejects SSH session rename when the name is empty", async () => {
    const workspace = await createWorkspace({ transport: "ssh" });

    const createResponse = await fetch(`${baseUrl}/api/ssh-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        name: "Original SSH Session",
        connectionMode: "dtach",
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { config: { id: string } };

    const renameResponse = await fetch(`${baseUrl}/api/ssh-sessions/${created.config.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "   ",
      }),
    });

    expect(renameResponse.status).toBe(400);
    const data = await renameResponse.json() as { message: string };
    expect(data.message).toContain("name is required");
  });

  test("creates SSH sessions with explicitly provided names", async () => {
    const workspace = await createWorkspace({ transport: "ssh" });
    const otherWorkspaceDir = await mkdtemp(join(tmpdir(), "clanky-ssh-sessions-work-"));
    try {
      await Bun.$`git init ${otherWorkspaceDir}`.quiet();
      await Bun.$`git -C ${otherWorkspaceDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${otherWorkspaceDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${otherWorkspaceDir}/README.md`.quiet();
      await Bun.$`git -C ${otherWorkspaceDir} add .`.quiet();
      await Bun.$`git -C ${otherWorkspaceDir} commit -m "Initial commit"`.quiet();
      const secondWorkspace = await createWorkspace({
        transport: "ssh",
        name: "Other Workspace",
        directory: otherWorkspaceDir,
      });

      const firstCreateResponse = await fetch(`${baseUrl}/api/ssh-sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: workspace.id,
          name: "SSH Workspace 1",
          connectionMode: "dtach",
        }),
      });
      expect(firstCreateResponse.status).toBe(201);
      const firstCreated = await firstCreateResponse.json() as { config: { name: string } };
      expect(firstCreated.config.name).toBe("SSH Workspace 1");

      const secondCreateResponse = await fetch(`${baseUrl}/api/ssh-sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: workspace.id,
          name: "SSH Workspace 2",
          connectionMode: "dtach",
        }),
      });
      expect(secondCreateResponse.status).toBe(201);
      const secondCreated = await secondCreateResponse.json() as { config: { name: string } };
      expect(secondCreated.config.name).toBe("SSH Workspace 2");

      const otherWorkspaceCreateResponse = await fetch(`${baseUrl}/api/ssh-sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: secondWorkspace.id,
          name: "Other Workspace 1",
          connectionMode: "dtach",
        }),
      });
      expect(otherWorkspaceCreateResponse.status).toBe(201);
      const otherWorkspaceCreated = await otherWorkspaceCreateResponse.json() as { config: { name: string } };
      expect(otherWorkspaceCreated.config.name).toBe("Other Workspace 1");
    } finally {
      await rm(otherWorkspaceDir, { recursive: true, force: true });
    }
  });

  test("defaults useTmux to false when omitted", async () => {
    const workspace = await createWorkspace({ transport: "ssh" });

    const response = await fetch(`${baseUrl}/api/ssh-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        name: "Default tmux session",
        connectionMode: "dtach",
      }),
    });

    expect(response.status).toBe(201);
    const session = await response.json() as { config: { useTmux: boolean } };
    expect(session.config.useTmux).toBe(false);
  });

  test("rejects session creation for non-ssh workspaces", async () => {
    const workspace = await createWorkspace({ transport: "stdio" });

    const response = await fetch(`${baseUrl}/api/ssh-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        name: "Invalid Session",
        connectionMode: "dtach",
      }),
    });

    expect(response.status).toBe(400);
    const data = await response.json() as { message: string };
    expect(data.message).toContain("ssh transport");
  });

  test("creates SSH sessions even when dtach is unavailable at creation time", async () => {
    backendManager.setExecutorFactoryForTesting(() => new MissingDtachExecutor());
    const workspace = await createWorkspace({ transport: "ssh" });

    const response = await fetch(`${baseUrl}/api/ssh-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        name: "Needs Persistent SSH",
        connectionMode: "dtach",
      }),
    });

    expect(response.status).toBe(201);
    const session = await response.json() as {
      config: { workspaceId: string; name: string; connectionMode: string };
      state: { status: string; runtimeConnectionMode?: string; notice?: string };
    };
    expect(session.config.workspaceId).toBe(workspace.id);
    expect(session.config.name).toBe("Needs Persistent SSH");
    expect(session.config.connectionMode).toBe("dtach");
    expect(session.state.status).toBe("ready");
    expect(session.state.runtimeConnectionMode).toBeUndefined();
    expect(session.state.notice).toBeUndefined();
  });

  test("deletes the session even when persistent remote cleanup fails", async () => {
    const workspace = await createWorkspace({ transport: "ssh" });

    const createResponse = await fetch(`${baseUrl}/api/ssh-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        name: "Cleanup Failure",
      connectionMode: "dtach",
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { config: { id: string } };

    backendManager.setExecutorFactoryForTesting(() => new FailingPersistentCleanupExecutor());

    const deleteResponse = await fetch(`${baseUrl}/api/ssh-sessions/${created.config.id}`, {
      method: "DELETE",
    });

    expect(deleteResponse.ok).toBe(true);
    expect(await deleteResponse.json()).toEqual({ success: true });

    const getResponse = await fetch(`${baseUrl}/api/ssh-sessions/${created.config.id}`);
    expect(getResponse.status).toBe(404);
  });
});
