import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "node:child_process";
import { LoopManager } from "../../src/core/loop-manager";
import { backendManager } from "../../src/core/backend-manager";
import { portForwardManager } from "../../src/core/port-forward-manager";
import { createMockBackend } from "../mocks/mock-backend";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { createWorkspace } from "../../src/persistence/workspaces";
import { closeDatabase, ensureDataDirectories } from "../../src/persistence/database";
import { savePortForward } from "../../src/persistence/forwarded-ports";
import { getDefaultServerSettings } from "../../src/types/settings";
import type { PortForward } from "../../src/types";

describe("PortForwardManager", () => {
  let dataDir: string;
  let workDir: string;
  let manager: LoopManager;
  let createdForwardId: string | null = null;
  const workspaceId = "workspace-1";
  const modelFields = {
    modelProviderID: "test-provider",
    modelID: "test-model",
    modelVariant: "",
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ralpher-port-forward-manager-data-"));
    workDir = await mkdtemp(join(tmpdir(), "ralpher-port-forward-manager-work-"));
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
      sshSettings.agent.hostname = "workspace.example.com";
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
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());
    portForwardManager.setSpawnFactoryForTesting(() => spawn("sleep", ["60"], { stdio: "ignore" }));
    portForwardManager.setLocalPortAllocatorForTesting(null);

    manager = new LoopManager();
  });

  afterEach(async () => {
    if (createdForwardId) {
      await portForwardManager.deletePortForward(createdForwardId);
      createdForwardId = null;
    }
    await manager.shutdown();
    backendManager.resetForTesting();
    portForwardManager.setLocalPortAllocatorForTesting(null);
    portForwardManager.setSpawnFactoryForTesting(null);
    closeDatabase();
    delete process.env["RALPHER_DATA_DIR"];
    await rm(dataDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  test("retries local port reservation when the active-port unique constraint is hit", async () => {
    const loop = await manager.createLoop({
      ...modelFields,
      directory: workDir,
      prompt: "Create a forwarded port",
      name: "Test Loop",
      workspaceId,
      planMode: false,
      useWorktree: true,
    });

    await portForwardManager.initialize();

    const reservedForward: PortForward = {
      config: {
        id: "existing-forward",
        loopId: loop.config.id,
        workspaceId,
        remoteHost: "127.0.0.1",
        remotePort: 8080,
        localPort: 41001,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      state: {
        status: "active",
      },
    };
    await savePortForward(reservedForward);

    const localPorts = [41001, 41002];
    portForwardManager.setLocalPortAllocatorForTesting(async () => {
      const nextPort = localPorts.shift();
      if (!nextPort) {
        throw new Error("Test allocator ran out of ports");
      }
      return nextPort;
    });

    const created = await portForwardManager.createLoopPortForward({
      loopId: loop.config.id,
      remotePort: 3000,
    });
    createdForwardId = created.config.id;

    expect(created.config.localPort).toBe(41002);
    expect(created.config.remoteHost).toBe("localhost");
    expect(created.state.status).toBe("active");
  });

  test("rejects duplicate remote ports for the same workspace", async () => {
    const firstLoop = await manager.createLoop({
      ...modelFields,
      directory: workDir,
      prompt: "Create first forwarded port",
      name: "Test Loop",
      workspaceId,
      planMode: false,
      useWorktree: true,
    });
    const secondLoop = await manager.createLoop({
      ...modelFields,
      directory: workDir,
      prompt: "Create duplicate forwarded port",
      name: "Test Loop",
      workspaceId,
      planMode: false,
      useWorktree: true,
    });

    const firstForward = await portForwardManager.createLoopPortForward({
      loopId: firstLoop.config.id,
      remotePort: 3000,
    });
    createdForwardId = firstForward.config.id;

    await expect(
      portForwardManager.createLoopPortForward({
        loopId: secondLoop.config.id,
        remotePort: 3000,
      }),
    ).rejects.toThrow("Port 3000 is already being forwarded for this workspace");
  });

  test("ignores unexpected exit callbacks after the database is closed", async () => {
    const loop = await manager.createLoop({
      ...modelFields,
      directory: workDir,
      prompt: "Create a forwarded port",
      name: "Test Loop",
      workspaceId,
      planMode: false,
      useWorktree: true,
    });
    const forward: PortForward = {
      config: {
        id: "closed-db-forward",
        loopId: loop.config.id,
        workspaceId,
        remoteHost: "localhost",
        remotePort: 3000,
        localPort: 41001,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      state: {
        status: "active",
      },
    };
    await savePortForward(forward);

    closeDatabase();

    const handleUnexpectedExit = Reflect.get(portForwardManager, "handleUnexpectedExit") as (
      portForwardId: string,
      deleting: boolean,
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => Promise<void>;

    await expect(
      handleUnexpectedExit.call(portForwardManager, forward.config.id, false, 1, null),
    ).resolves.toBeUndefined();
  });
});
