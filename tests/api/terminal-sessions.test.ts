import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDatabase, initializeDatabase } from "../../src/persistence/database";
import { backendManager } from "../../src/core/backend-manager";
import { createMockBackend } from "../mocks/mock-backend";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { type Server } from "bun";
import { serveNativeApiRoutes } from "../native-api-server";
import { join } from "path";
import { initializeGitRepository } from "../helpers/git-fixtures";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import type { WorkspaceTerminalSession } from "../../src/shared";

class TerminalSessionTestExecutor extends TestCommandExecutor {
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

describe("Terminal sessions API integration", () => {
  let dataDir: string;
  let workDir: string;
  let server: Server<unknown>;
  let baseUrl: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clanky-terminal-sessions-data-"));
    workDir = await mkdtemp(join(tmpdir(), "clanky-terminal-sessions-work-"));
    process.env["CLANKY_DATA_DIR"] = dataDir;

    await initializeDatabase();
    await initializeGitRepository(workDir, { initialCommit: "readme" });

    backendManager.setBackendForTesting(createMockBackend());
    backendManager.setExecutorFactoryForTesting(() => new TerminalSessionTestExecutor());

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
    db.run("DELETE FROM terminal_sessions");
    db.run("DELETE FROM tasks WHERE workspace_id IS NOT NULL");
    db.run("DELETE FROM workspaces");
    backendManager.setExecutorFactoryForTesting(() => new TerminalSessionTestExecutor());
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
        name: options.name ?? "Test Workspace",
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

  test("creates, lists, fetches, and deletes a terminal session for SSH workspace", async () => {
    const workspace = await createWorkspace({ transport: "ssh" });

    const createResponse = await fetch(`${baseUrl}/api/terminal-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        name: "My Terminal",
        connectionMode: "dtach",
        useTmux: false,
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as WorkspaceTerminalSession;
    expect(created.config.name).toBe("My Terminal");
    expect(created.config.useTmux).toBe(false);
    expect(created.config.targetBinding.transport).toBe("ssh");
    expect(created.config.targetBinding.hostname).toBe("localhost");
    expect(created.config.targetBinding.username).toBe("tester");

    const listResponse = await fetch(`${baseUrl}/api/terminal-sessions`);
    expect(listResponse.ok).toBe(true);
    const sessions = await listResponse.json() as WorkspaceTerminalSession[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.config.id).toBe(created.config.id);

    const getResponse = await fetch(`${baseUrl}/api/terminal-sessions/${created.config.id}`);
    expect(getResponse.ok).toBe(true);
    const fetched = await getResponse.json() as WorkspaceTerminalSession;
    expect(fetched.config.remoteSessionName).toContain("clanky-");

    const deleteResponse = await fetch(`${baseUrl}/api/terminal-sessions/${created.config.id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.ok).toBe(true);

    const listAfterDelete = await fetch(`${baseUrl}/api/terminal-sessions`);
    expect(listAfterDelete.ok).toBe(true);
    expect(await listAfterDelete.json()).toEqual([]);
  });

  test("creates a terminal session for local stdio workspace", async () => {
    const workspace = await createWorkspace({ transport: "stdio" });

    const createResponse = await fetch(`${baseUrl}/api/terminal-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        name: "Local Terminal",
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as WorkspaceTerminalSession;
    expect(created.config.name).toBe("Local Terminal");
    expect(created.config.targetBinding.transport).toBe("stdio");
    expect(created.config.targetBinding.hostname).toBeUndefined();
    expect(created.config.connectionMode).toBe("dtach");
    expect(created.state.status).toBe("ready");
  });

  test("renames a terminal session", async () => {
    const workspace = await createWorkspace({ transport: "ssh" });

    const createResponse = await fetch(`${baseUrl}/api/terminal-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        name: "Original Name",
        connectionMode: "dtach",
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as WorkspaceTerminalSession;

    const renameResponse = await fetch(`${baseUrl}/api/terminal-sessions/${created.config.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Renamed Terminal",
      }),
    });

    expect(renameResponse.ok).toBe(true);
    const renamed = await renameResponse.json() as WorkspaceTerminalSession;
    expect(renamed.config.id).toBe(created.config.id);
    expect(renamed.config.name).toBe("Renamed Terminal");
  });

  test("rejects rename with empty name", async () => {
    const workspace = await createWorkspace({ transport: "ssh" });

    const createResponse = await fetch(`${baseUrl}/api/terminal-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        name: "Terminal",
        connectionMode: "dtach",
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as WorkspaceTerminalSession;

    const renameResponse = await fetch(`${baseUrl}/api/terminal-sessions/${created.config.id}`, {
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

  test("filters sessions by workspaceId", async () => {
    const workspace1 = await createWorkspace({ transport: "ssh", name: "Workspace 1" });
    const otherDir = await mkdtemp(join(tmpdir(), "clanky-terminal-sessions-work2-"));
    try {
      await initializeGitRepository(otherDir, { initialCommit: "readme" });
      const workspace2 = await createWorkspace({ transport: "ssh", name: "Workspace 2", directory: otherDir });

      await fetch(`${baseUrl}/api/terminal-sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace1.id, name: "T1", connectionMode: "dtach" }),
      });
      await fetch(`${baseUrl}/api/terminal-sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace2.id, name: "T2", connectionMode: "dtach" }),
      });

      const filtered = await fetch(`${baseUrl}/api/terminal-sessions?workspaceId=${workspace1.id}`);
      expect(filtered.ok).toBe(true);
      const sessions = await filtered.json() as WorkspaceTerminalSession[];
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.config.name).toBe("T1");

      const all = await fetch(`${baseUrl}/api/terminal-sessions`);
      expect(all.ok).toBe(true);
      const allSessions = await all.json() as WorkspaceTerminalSession[];
      expect(allSessions).toHaveLength(2);
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  test("defaults connectionMode to dtach", async () => {
    const workspace = await createWorkspace({ transport: "stdio" });

    const response = await fetch(`${baseUrl}/api/terminal-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        name: "Default mode terminal",
      }),
    });

    expect(response.status).toBe(201);
    const session = await response.json() as WorkspaceTerminalSession;
    expect(session.config.connectionMode).toBe("dtach");
    expect(session.config.useTmux).toBe(false);
  });

  test("target binding captures SSH workspace settings", async () => {
    const workspace = await createWorkspace({ transport: "ssh" });

    const response = await fetch(`${baseUrl}/api/terminal-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        name: "SSH Target",
        connectionMode: "dtach",
      }),
    });

    expect(response.status).toBe(201);
    const session = await response.json() as WorkspaceTerminalSession;
    const binding = session.config.targetBinding;
    expect(binding.transport).toBe("ssh");
    expect(binding.hostname).toBe("localhost");
    expect(binding.username).toBe("tester");
    expect(binding.executionNodeId).toBeUndefined();
  });

  test("target binding captures stdio workspace settings", async () => {
    const workspace = await createWorkspace({ transport: "stdio" });

    const response = await fetch(`${baseUrl}/api/terminal-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        name: "Stdio Target",
      }),
    });

    expect(response.status).toBe(201);
    const session = await response.json() as WorkspaceTerminalSession;
    const binding = session.config.targetBinding;
    expect(binding.transport).toBe("stdio");
    expect(binding.hostname).toBeUndefined();
    expect(binding.port).toBeUndefined();
    expect(binding.username).toBeUndefined();
  });

  test("returns 404 for non-existent session", async () => {
    const response = await fetch(`${baseUrl}/api/terminal-sessions/non-existent-id`);
    expect(response.status).toBe(404);
  });

  test("returns 404 when deleting non-existent session", async () => {
    const response = await fetch(`${baseUrl}/api/terminal-sessions/non-existent-id`, {
      method: "DELETE",
    });
    expect(response.status).toBe(404);
  });
});
