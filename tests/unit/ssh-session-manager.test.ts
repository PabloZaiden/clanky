import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { LoopManager } from "../../src/core/loop-manager";
import { backendManager } from "../../src/core/backend-manager";
import { createMockBackend } from "../mocks/mock-backend";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { createWorkspace } from "../../src/persistence/workspaces";
import { updateLoopState } from "../../src/persistence/loops";
import { closeDatabase, ensureDataDirectories, getDatabase } from "../../src/persistence/database";
import { getDefaultServerSettings } from "../../src/types/settings";
import { sshSessionManager } from "../../src/core/ssh-session-manager";
import { portForwardManager } from "../../src/core/port-forward-manager";
import { spawn } from "node:child_process";

class SshCapableExecutor extends TestCommandExecutor {
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

class FailingDeleteExecutor extends SshCapableExecutor {
  override async exec(command: string, args: string[], options?: Parameters<TestCommandExecutor["exec"]>[2]) {
    if (command === "bash" && args[0] === "-lc" && args[1]?.includes(".dtach.sock")) {
      this.deleteCommands.push(args[1]);
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

describe("SshSessionManager loop-linked sessions", () => {
  let dataDir: string;
  let workDir: string;
  let manager: LoopManager;
  let executor: SshCapableExecutor;
  const workspaceId = "workspace-1";
  const modelFields = {
    modelProviderID: "test-provider",
    modelID: "test-model",
    modelVariant: "",
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ralpher-ssh-session-manager-data-"));
    workDir = await mkdtemp(join(tmpdir(), "ralpher-ssh-session-manager-work-"));
    process.env["RALPHER_DATA_DIR"] = dataDir;

    await ensureDataDirectories();
    await Bun.$`git init ${workDir}`.quiet();
    await Bun.$`git -C ${workDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${workDir} config user.name "Test User"`.quiet();
    await Bun.$`touch ${workDir}/README.md`.quiet();
    await Bun.$`git -C ${workDir} add .`.quiet();
    await Bun.$`git -C ${workDir} commit -m "Initial commit"`.quiet();

    const sshSettings = getDefaultServerSettings(true);
    if (sshSettings.agent.transport === "ssh") {
      sshSettings.agent.hostname = "localhost";
      sshSettings.agent.username = "tester";
    }

    await createWorkspace({
      id: workspaceId,
      name: "SSH Workspace",
      directory: workDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      serverSettings: sshSettings,
    });

    backendManager.setBackendForTesting(createMockBackend());
    executor = new SshCapableExecutor();
    backendManager.setExecutorFactoryForTesting(() => executor);
    portForwardManager.setSpawnFactoryForTesting(() => spawn("sleep", ["60"], { stdio: "ignore" }));

    manager = new LoopManager();
  });

  afterEach(async () => {
    await manager.shutdown();
    backendManager.resetForTesting();
    portForwardManager.setSpawnFactoryForTesting(null);
    closeDatabase();
    delete process.env["RALPHER_DATA_DIR"];
    await rm(dataDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  test("getOrCreateLoopSession reuses the same linked session and uses the worktree path", async () => {
    const loop = await manager.createLoop({
      ...modelFields,
      directory: workDir,
      prompt: "Link me to SSH",
      name: "Test Loop",
      workspaceId,
      planMode: false,
      useWorktree: true,
    });
    const worktreePath = join(workDir, ".ralph-worktrees", loop.config.id);

    await updateLoopState(loop.config.id, {
      ...loop.state,
      git: {
        originalBranch: "main",
        workingBranch: "test-loop-a1b2c3d",
        worktreePath,
        commits: [],
      },
    });

    const firstSession = await sshSessionManager.getOrCreateLoopSession(loop.config.id);
    const secondSession = await sshSessionManager.getOrCreateLoopSession(loop.config.id);

    expect(firstSession.config.loopId).toBe(loop.config.id);
    expect(firstSession.config.directory).toBe(worktreePath);
    expect(firstSession.config.name.endsWith(" SSH")).toBe(true);
    expect(secondSession.config.id).toBe(firstSession.config.id);
  });

  test("purgeLoop deletes the linked SSH session and stops the persistent session", async () => {
    const loop = await manager.createLoop({
      ...modelFields,
      directory: workDir,
      prompt: "Purge linked ssh session",
      name: "Test Loop",
      workspaceId,
      planMode: false,
      useWorktree: true,
    });
    const worktreePath = join(workDir, ".ralph-worktrees", loop.config.id);

    await updateLoopState(loop.config.id, {
      ...loop.state,
      status: "deleted",
      git: {
        originalBranch: "main",
        workingBranch: "purge-loop-a1b2c3d",
        worktreePath,
        commits: [],
      },
    });

    const session = await sshSessionManager.getOrCreateLoopSession(loop.config.id);
    const result = await manager.purgeLoop(loop.config.id);

    expect(result).toEqual({ success: true });
    expect(await sshSessionManager.getSession(session.config.id)).toBeNull();
    expect(executor.deleteCommands.some((command) => command.includes(session.config.remoteSessionName))).toBe(true);
  });

  test("purgeLoop deletes loop-owned port forwards", async () => {
    const loop = await manager.createLoop({
      ...modelFields,
      directory: workDir,
      prompt: "Purge linked port forwards",
      name: "Test Loop",
      workspaceId,
      planMode: false,
      useWorktree: true,
    });
    const worktreePath = join(workDir, ".ralph-worktrees", loop.config.id);

    await updateLoopState(loop.config.id, {
      ...loop.state,
      status: "deleted",
      git: {
        originalBranch: "main",
        workingBranch: "purge-forwards-a1b2c3d",
        worktreePath,
        commits: [],
      },
    });

    const forward = await portForwardManager.createLoopPortForward({
      loopId: loop.config.id,
      remotePort: 3000,
    });

    const result = await manager.purgeLoop(loop.config.id);

    expect(result).toEqual({ success: true });
    expect(await portForwardManager.getPortForward(forward.config.id)).toBeNull();
  });

  test("deleting an SSH session also deletes linked port forwards", async () => {
    const loop = await manager.createLoop({
      ...modelFields,
      directory: workDir,
      prompt: "Delete linked port forwards",
      name: "Test Loop",
      workspaceId,
      planMode: false,
      useWorktree: true,
    });
    const worktreePath = join(workDir, ".ralph-worktrees", loop.config.id);

    await updateLoopState(loop.config.id, {
      ...loop.state,
      git: {
        originalBranch: "main",
        workingBranch: "delete-forwards-a1b2c3d",
        worktreePath,
        commits: [],
      },
    });

    const session = await sshSessionManager.getOrCreateLoopSession(loop.config.id);
    const forward = await portForwardManager.createLoopPortForward({
      loopId: loop.config.id,
      remotePort: 3000,
    });

    await sshSessionManager.deleteSession(session.config.id);

    expect(await portForwardManager.getPortForward(forward.config.id)).toBeNull();
  });

  test("deletes a workspace SSH session even when its workspace record is missing", async () => {
    const loop = await manager.createLoop({
      ...modelFields,
      directory: workDir,
      prompt: "Delete session without workspace",
      name: "Test Loop",
      workspaceId,
      planMode: false,
      useWorktree: true,
    });
    const worktreePath = join(workDir, ".ralph-worktrees", loop.config.id);

    await updateLoopState(loop.config.id, {
      ...loop.state,
      git: {
        originalBranch: "main",
        workingBranch: "missing-workspace-a1b2c3d",
        worktreePath,
        commits: [],
      },
    });

    const session = await sshSessionManager.getOrCreateLoopSession(loop.config.id);
    const db = getDatabase();
    db.run("PRAGMA foreign_keys = OFF");
    try {
      db.run("DELETE FROM workspaces WHERE id = ?", [workspaceId]);
    } finally {
      db.run("PRAGMA foreign_keys = ON");
    }

    const deleted = await sshSessionManager.deleteSession(session.config.id);

    expect(deleted).toBe(true);
    expect(await sshSessionManager.getSession(session.config.id)).toBeNull();
  });

  test("deletes a failed SSH session even when remote cleanup fails again", async () => {
    const loop = await manager.createLoop({
      ...modelFields,
      directory: workDir,
      prompt: "Delete failed session",
      name: "Test Loop",
      workspaceId,
      planMode: false,
      useWorktree: true,
    });
    const worktreePath = join(workDir, ".ralph-worktrees", loop.config.id);

    await updateLoopState(loop.config.id, {
      ...loop.state,
      git: {
        originalBranch: "main",
        workingBranch: "failed-session-a1b2c3d",
        worktreePath,
        commits: [],
      },
    });

    const session = await sshSessionManager.getOrCreateLoopSession(loop.config.id);
    await sshSessionManager.markStatus(session.config.id, "failed", "dtach socket is gone");

    const failingExecutor = new FailingDeleteExecutor();
    backendManager.setExecutorFactoryForTesting(() => failingExecutor);

    const deleted = await sshSessionManager.deleteSession(session.config.id);

    expect(deleted).toBe(true);
    expect(await sshSessionManager.getSession(session.config.id)).toBeNull();
    expect(failingExecutor.deleteCommands.some((command) => command.includes(session.config.remoteSessionName))).toBe(true);
  });
});
