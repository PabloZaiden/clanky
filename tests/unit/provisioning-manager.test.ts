import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backendManager } from "../../src/core/backend-manager";
import {
  extractRepoName,
  parseDevboxCredentialContent,
  parseDevboxStatusOutput,
  ProvisioningManager,
  provisioningManager,
} from "../../src/core/provisioning-manager";
import { sshServerManager } from "../../src/core/ssh-server-manager";
import { getWorkspace } from "../../src/persistence/workspaces";
import { ensureDataDirectories, getDatabase } from "../../src/persistence/database";
import { createMockBackend } from "../mocks/mock-backend";
import {
  createDevboxStatusOutput,
  ProvisioningTestExecutor,
} from "../mocks/provisioning-test-executor";

async function waitForProvisioningStatus(
  manager: ProvisioningManager,
  jobId: string,
  expectedStatuses: Array<"completed" | "failed" | "cancelled">,
): Promise<NonNullable<Awaited<ReturnType<ProvisioningManager["getJobSnapshot"]>>>> {
  const deadline = Date.now() + 5000;
  let lastSnapshot: Awaited<ReturnType<ProvisioningManager["getJobSnapshot"]>> = null;

  while (Date.now() < deadline) {
    lastSnapshot = await manager.getJobSnapshot(jobId);
    if (lastSnapshot && expectedStatuses.includes(lastSnapshot.job.state.status as never)) {
      return lastSnapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for provisioning status. Last snapshot: ${JSON.stringify(lastSnapshot)}`);
}

describe("ProvisioningManager", () => {
  let testDataDir: string;

  beforeEach(async () => {
    testDataDir = await mkdtemp(join(tmpdir(), "clanky-provisioning-unit-"));
    process.env["CLANKY_DATA_DIR"] = testDataDir;
    await ensureDataDirectories();
    const db = getDatabase();
    db.run("DELETE FROM workspaces");
    db.run("DELETE FROM ssh_server_sessions");
    db.run("DELETE FROM ssh_servers");
    backendManager.setBackendForTesting(createMockBackend());
    provisioningManager.resetForTesting();
  });

  afterEach(async () => {
    sshServerManager.setExecutorFactoryForTesting(null);
    backendManager.resetForTesting();
    provisioningManager.resetForTesting();
    await rm(testDataDir, { recursive: true, force: true });
    delete process.env["CLANKY_DATA_DIR"];
  });

  test("extractRepoName handles https and SSH repository URLs", () => {
    expect(extractRepoName("https://github.com/octocat/example.git")).toBe("example");
    expect(extractRepoName("https://github.com/octocat/example")).toBe("example");
    expect(extractRepoName("git@github.com:octocat/example.git")).toBe("example");
  });

  test("parseDevboxStatusOutput validates JSON devbox output", () => {
    const parsed = parseDevboxStatusOutput(createDevboxStatusOutput({
      sshUser: null,
      password: null,
    }));
    expect(parsed.running).toBe(true);
    expect(parsed.port).toBe(5005);
    expect(parsed.sshUser).toBeNull();
    expect(parsed.password).toBeNull();
  });

  test("parseDevboxCredentialContent supports JSON and key-value formats", () => {
    expect(parseDevboxCredentialContent(JSON.stringify({
      username: "vscode",
      password: "secret",
    }))).toEqual({
      username: "vscode",
      password: "secret",
    });
    expect(parseDevboxCredentialContent("user=vscode\npassword=secret\n")).toEqual({
      username: "vscode",
      password: "secret",
    });
  });

  test("provisions a workspace and falls back to .sshcred when devbox status omits password", async () => {
    const server = await sshServerManager.createServer({
      name: "Builder",
      address: "10.0.0.5",
      username: "remote-user",
      repositoriesBasePath: null,
    });
    const executor = new ProvisioningTestExecutor({
      devboxStatusOutput: createDevboxStatusOutput({
        sshUser: null,
        password: null,
        hasCredentialFile: true,
        credentialPath: "/tmp/devbox/.sshcred",
      }),
      credentialFileContent: "username=devbox-user\npassword=devbox-secret\n",
    });
    sshServerManager.setExecutorFactoryForTesting(() => executor);

    const manager = new ProvisioningManager(5_000, 500);
    const started = await manager.startJob({
      name: "Automatic Workspace",
      sshServerId: server.config.id,
      repoUrl: "git@github.com:octocat/example.git",
      basePath: "/workspaces",
      provider: "copilot",
    });

    const snapshot = await waitForProvisioningStatus(manager, started.job.config.id, ["completed"]);
    expect(snapshot.job.state.status).toBe("completed");
    expect(snapshot.job.state.currentStep).toBe("workspace_ready");
    expect(snapshot.job.state.workspaceId).toBeTruthy();

    const workspace = await getWorkspace(snapshot.job.state.workspaceId!);
    expect(workspace?.directory).toBe("/workspaces/devbox");
    expect(workspace?.serverSettings.agent.transport).toBe("ssh");
    if (workspace?.serverSettings.agent.transport !== "ssh") {
      throw new Error("Expected SSH transport");
    }
    expect(workspace.serverSettings.agent.hostname).toBe("10.0.0.5");
    expect(workspace.serverSettings.agent.port).toBe(5005);
    expect(workspace.serverSettings.agent.username).toBe("devbox-user");
    expect(workspace.serverSettings.agent.password).toBe("devbox-secret");
    expect(snapshot.logs.at(-1)?.text).toBe(
      "Workspace connection test succeeded. Workspace Automatic Workspace was created successfully and is ready.",
    );
    expect(snapshot.logs.at(-1)?.step).toBe("workspace_ready");
    expect(executor.calls[0]).toEqual({
      command: "bash",
      args: ["-lc", "command -v devbox >/dev/null 2>&1"],
      cwd: "/",
    });
  });

  test("provisions a workspace and persists provisioning metadata", async () => {
    const server = await sshServerManager.createServer({
      name: "Metadata Test",
      address: "10.0.0.6",
      username: "remote-user",
      repositoriesBasePath: null,
    });
    const executor = new ProvisioningTestExecutor();
    sshServerManager.setExecutorFactoryForTesting(() => executor);

    const manager = new ProvisioningManager(5_000, 500);
    const started = await manager.startJob({
      name: "Auto Workspace Metadata",
      sshServerId: server.config.id,
      repoUrl: "git@github.com:octocat/example.git",
      basePath: "/workspaces",
      devcontainerSubpath: ".devcontainer/backend/devcontainer.json",
      provider: "copilot",
    });

    const snapshot = await waitForProvisioningStatus(manager, started.job.config.id, ["completed"]);
    expect(snapshot.job.state.status).toBe("completed");

    const workspace = await getWorkspace(snapshot.job.state.workspaceId!);
    expect(workspace?.sourceDirectory).toBe("/workspaces/example");
    expect(workspace?.sshServerId).toBe(server.config.id);
    expect(workspace?.repoUrl).toBe("git@github.com:octocat/example.git");
    expect(workspace?.basePath).toBe("/workspaces");
    expect(workspace?.devcontainerSubpath).toBe(".devcontainer/backend/devcontainer.json");
    expect(workspace?.provider).toBe("copilot");
    expect(started.job.config.devcontainerSubpath).toBe(".devcontainer/backend/devcontainer.json");

    const devboxUpCall = executor.calls.find((call) => call.command === "devbox" && call.args[0] === "up");
    expect(devboxUpCall?.args).toEqual([
      "up",
      "--devcontainer-subpath",
      ".devcontainer/backend/devcontainer.json",
    ]);
  });

  test("provisions a workspace with a devbox template override", async () => {
    const server = await sshServerManager.createServer({
      name: "Template Test",
      address: "10.0.0.16",
      username: "remote-user",
      repositoriesBasePath: null,
    });
    const executor = new ProvisioningTestExecutor();
    sshServerManager.setExecutorFactoryForTesting(() => executor);

    const manager = new ProvisioningManager(5_000, 500);
    const started = await manager.startJob({
      name: "Template Workspace",
      sshServerId: server.config.id,
      repoUrl: "git@github.com:octocat/example.git",
      basePath: "/workspaces",
      devcontainerSubpath: ".devcontainer/backend/devcontainer.json",
      devboxTemplate: "python",
      provider: "copilot",
    });

    const snapshot = await waitForProvisioningStatus(manager, started.job.config.id, ["completed"]);
    expect(snapshot.job.state.status).toBe("completed");
    expect(started.job.config.devboxTemplate).toBe("python");

    const devboxUpCall = executor.calls.find((call) => call.command === "devbox" && call.args[0] === "up");
    expect(devboxUpCall?.args).toEqual([
      "up",
      "--template",
      "python",
    ]);
  });

  test("provisions a new workspace by initializing an empty git repository without a remote", async () => {
    const server = await sshServerManager.createServer({
      name: "New Repo Test",
      address: "10.0.0.17",
      username: "remote-user",
      repositoriesBasePath: null,
    });
    const executor = new ProvisioningTestExecutor({
      devboxStatusOutput: createDevboxStatusOutput({
        workdir: "/workspaces/New_Workspace/devbox",
      }),
    });
    sshServerManager.setExecutorFactoryForTesting(() => executor);

    const manager = new ProvisioningManager(5_000, 500);
    const started = await manager.startJob({
      name: "New_Workspace",
      sshServerId: server.config.id,
      repoUrl: "",
      basePath: "/workspaces",
      devboxTemplate: "python",
      provider: "copilot",
      createNewRepository: true,
    });

    const snapshot = await waitForProvisioningStatus(manager, started.job.config.id, ["completed"]);
    expect(snapshot.job.state.status).toBe("completed");
    expect(snapshot.job.state.targetDirectory).toBe("/workspaces/New_Workspace");
    expect(started.job.config.createNewRepository).toBe(true);
    expect(started.job.config.repoUrl).toBeUndefined();

    const workspace = await getWorkspace(snapshot.job.state.workspaceId!);
    expect(workspace?.sourceDirectory).toBe("/workspaces/New_Workspace");
    expect(workspace?.repoUrl).toBeUndefined();

    expect(executor.calls.some((call) => call.command === "git" && call.args[0] === "clone")).toBe(false);
    expect(executor.calls).toContainEqual({
      command: "mkdir",
      args: ["-p", "/workspaces/New_Workspace"],
      cwd: "/",
    });
    expect(executor.calls).toContainEqual({
      command: "git",
      args: ["init", "-b", "main"],
      cwd: "/workspaces/New_Workspace",
    });
    expect(executor.calls.find((call) => call.command === "devbox" && call.args[0] === "up")).toEqual({
      command: "devbox",
      args: ["up", "--template", "python"],
      cwd: "/workspaces/New_Workspace",
    });
  });

  test("rejects new repository provisioning when the target directory already exists", async () => {
    const server = await sshServerManager.createServer({
      name: "Existing Target Test",
      address: "10.0.0.18",
      username: "remote-user",
      repositoriesBasePath: null,
    });
    const executor = new ProvisioningTestExecutor({
      existingDirectories: ["/workspaces/New_Workspace"],
    });
    sshServerManager.setExecutorFactoryForTesting(() => executor);

    const manager = new ProvisioningManager(5_000, 500);
    const started = await manager.startJob({
      name: "New_Workspace",
      sshServerId: server.config.id,
      repoUrl: "",
      basePath: "/workspaces",
      devboxTemplate: "python",
      provider: "copilot",
      createNewRepository: true,
    });

    const snapshot = await waitForProvisioningStatus(manager, started.job.config.id, ["failed"]);
    expect(snapshot.job.state.error?.code).toBe("clone_conflict");
    expect(executor.calls.some((call) => call.command === "git" && call.args[0] === "init")).toBe(false);
  });

  test("rebuilds an existing devbox workspace without cloning", async () => {
    const server = await sshServerManager.createServer({
      name: "Rebuild Host",
      address: "10.0.0.7",
      username: "remote-user",
      repositoriesBasePath: null,
    });

    // First, provision a workspace
    const provisionExecutor = new ProvisioningTestExecutor();
    sshServerManager.setExecutorFactoryForTesting(() => provisionExecutor);

    const manager = new ProvisioningManager(5_000, 500);
    const provisionSnapshot = await manager.startJob({
      name: "Rebuild Target",
      sshServerId: server.config.id,
      repoUrl: "git@github.com:octocat/example.git",
      basePath: "/workspaces",
      devcontainerSubpath: ".devcontainer/backend/devcontainer.json",
      provider: "copilot",
    });
    const provisioned = await waitForProvisioningStatus(manager, provisionSnapshot.job.config.id, ["completed"]);
    const workspaceId = provisioned.job.state.workspaceId!;
    const workspace = await getWorkspace(workspaceId);
    expect(workspace).not.toBeNull();

    // Now rebuild using a new executor (simulates fresh devbox)
    const rebuildExecutor = new ProvisioningTestExecutor({
      existingDirectories: ["/workspaces/example"],
    });
    sshServerManager.setExecutorFactoryForTesting(() => rebuildExecutor);

    const rebuildSnapshot = await manager.startJob({
      name: "Rebuild Target",
      sshServerId: server.config.id,
      repoUrl: "git@github.com:octocat/example.git",
      basePath: "/workspaces",
      provider: "copilot",
      mode: "rebuild",
      targetDirectory: "/workspaces/example",
      workspaceId,
    });

    const rebuilt = await waitForProvisioningStatus(manager, rebuildSnapshot.job.config.id, ["completed"]);
    expect(rebuilt.job.state.status).toBe("completed");
    expect(rebuilt.job.config.mode).toBe("rebuild");
    expect(rebuilt.job.state.workspaceAction).toBe("reused");

    // Verify rebuild used devbox rebuild instead of devbox up
    const rebuildCalls = rebuildExecutor.calls.map((c) => `${c.command} ${c.args.join(" ")}`);
    expect(rebuildCalls.some((c) => c.includes("devbox rebuild"))).toBe(true);
    expect(rebuildCalls.some((c) => c.includes("--devcontainer-subpath .devcontainer/backend/devcontainer.json"))).toBe(true);
    expect(rebuildCalls.some((c) => c.includes("devbox up"))).toBe(false);
    expect(rebuildCalls.some((c) => c.includes("git clone"))).toBe(false);

    // Verify workspace server settings were updated
    const updatedWorkspace = await getWorkspace(workspaceId);
    expect(updatedWorkspace?.serverSettings.agent.transport).toBe("ssh");
    expect(updatedWorkspace?.devcontainerSubpath).toBe(".devcontainer/backend/devcontainer.json");

    // Verify final log message
    expect(rebuilt.logs.at(-1)?.text).toContain("rebuilt successfully");
  });

  test("restarts an existing devbox workspace without cloning", async () => {
    const server = await sshServerManager.createServer({
      name: "Restart Host",
      address: "10.0.0.9",
      username: "remote-user",
      repositoriesBasePath: null,
    });

    const provisionExecutor = new ProvisioningTestExecutor();
    sshServerManager.setExecutorFactoryForTesting(() => provisionExecutor);

    const manager = new ProvisioningManager(5_000, 500);
    const provisionSnapshot = await manager.startJob({
      name: "Restart Target",
      sshServerId: server.config.id,
      repoUrl: "git@github.com:octocat/example.git",
      basePath: "/workspaces",
      provider: "copilot",
    });
    const provisioned = await waitForProvisioningStatus(manager, provisionSnapshot.job.config.id, ["completed"]);
    const workspaceId = provisioned.job.state.workspaceId!;
    const workspace = await getWorkspace(workspaceId);
    expect(workspace).not.toBeNull();

    const restartExecutor = new ProvisioningTestExecutor({
      existingDirectories: ["/workspaces/example"],
    });
    sshServerManager.setExecutorFactoryForTesting(() => restartExecutor);

    const restartSnapshot = await manager.startJob({
      name: "Restart Target",
      sshServerId: server.config.id,
      repoUrl: "git@github.com:octocat/example.git",
      basePath: "/workspaces",
      provider: "copilot",
      mode: "restart",
      targetDirectory: "/workspaces/example",
      workspaceId,
    });

    const restarted = await waitForProvisioningStatus(manager, restartSnapshot.job.config.id, ["completed"]);
    expect(restarted.job.state.status).toBe("completed");
    expect(restarted.job.config.mode).toBe("restart");
    expect(restarted.job.state.workspaceAction).toBe("reused");

    const restartCalls = restartExecutor.calls.map((c) => `${c.command} ${c.args.join(" ")}`);
    expect(restartCalls.some((c) => c.includes("devbox up"))).toBe(true);
    expect(restartCalls.some((c) => c.includes("devbox rebuild"))).toBe(false);
    expect(restartCalls.some((c) => c.includes("git clone"))).toBe(false);

    const updatedWorkspace = await getWorkspace(workspaceId);
    expect(updatedWorkspace?.serverSettings.agent.transport).toBe("ssh");

    expect(restarted.logs.at(-1)?.text).toContain("restarted successfully");
  });

  test("rebuild fails when target directory does not exist", async () => {
    const server = await sshServerManager.createServer({
      name: "Rebuild Fail Host",
      address: "10.0.0.8",
      username: "remote-user",
      repositoriesBasePath: null,
    });

    // Create a workspace manually
    const db = getDatabase();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workspaces (id, name, directory, server_fingerprint, server_settings, created_at, updated_at, source_directory, ssh_server_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["ws-rebuild-fail", "Missing Dir WS", "/workspaces/devbox", "copilot:ssh:10.0.0.8:5005:", '{"agent":{"provider":"copilot","transport":"ssh","hostname":"10.0.0.8","port":5005,"username":"vscode","password":"test"}}', now, now, "/workspaces/missing", server.config.id],
    );

    // Executor with NO existing directories
    const executor = new ProvisioningTestExecutor();
    sshServerManager.setExecutorFactoryForTesting(() => executor);

    const manager = new ProvisioningManager(5_000, 500);
    const snapshot = await manager.startJob({
      name: "Missing Dir WS",
      sshServerId: server.config.id,
      repoUrl: "",
      basePath: "",
      provider: "copilot",
      mode: "rebuild",
      targetDirectory: "/workspaces/missing",
      workspaceId: "ws-rebuild-fail",
    });

    const result = await waitForProvisioningStatus(manager, snapshot.job.config.id, ["failed"]);
    expect(result.job.state.status).toBe("failed");
    expect(result.job.state.error?.code).toBe("directory_not_found");
  });

  test("restart fails when target directory does not exist", async () => {
    const server = await sshServerManager.createServer({
      name: "Restart Fail Host",
      address: "10.0.0.10",
      username: "remote-user",
      repositoriesBasePath: null,
    });

    const db = getDatabase();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workspaces (id, name, directory, server_fingerprint, server_settings, created_at, updated_at, source_directory, ssh_server_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["ws-restart-fail", "Missing Dir Restart WS", "/workspaces/devbox", "copilot:ssh:10.0.0.10:5005:", '{"agent":{"provider":"copilot","transport":"ssh","hostname":"10.0.0.10","port":5005,"username":"vscode","password":"test"}}', now, now, "/workspaces/missing", server.config.id],
    );

    const executor = new ProvisioningTestExecutor();
    sshServerManager.setExecutorFactoryForTesting(() => executor);

    const manager = new ProvisioningManager(5_000, 500);
    const snapshot = await manager.startJob({
      name: "Missing Dir Restart WS",
      sshServerId: server.config.id,
      repoUrl: "",
      basePath: "",
      provider: "copilot",
      mode: "restart",
      targetDirectory: "/workspaces/missing",
      workspaceId: "ws-restart-fail",
    });

    const result = await waitForProvisioningStatus(manager, snapshot.job.config.id, ["failed"]);
    expect(result.job.state.status).toBe("failed");
    expect(result.job.state.error?.code).toBe("directory_not_found");
  });

  test("runs devbox arise as a server-level job", async () => {
    const server = await sshServerManager.createServer({
      name: "Arise Host",
      address: "10.0.0.11",
      username: "remote-user",
      repositoriesBasePath: "/workspaces",
    });
    const executor = new ProvisioningTestExecutor();
    sshServerManager.setExecutorFactoryForTesting(() => executor);

    const manager = new ProvisioningManager(5_000, 500);
    const started = await manager.startJob({
      name: server.config.name,
      sshServerId: server.config.id,
      repoUrl: "",
      basePath: server.config.repositoriesBasePath ?? "",
      provider: "copilot",
      mode: "arise",
    });

    const snapshot = await waitForProvisioningStatus(manager, started.job.config.id, ["completed"]);
    expect(snapshot.job.state.status).toBe("completed");
    expect(snapshot.job.state.currentStep).toBe("arise_complete");
    expect(snapshot.workspace).toBeUndefined();
    expect(snapshot.logs.at(-1)?.text).toBe("Devbox arise completed successfully for Arise Host.");
    expect(snapshot.logs.at(-1)?.step).toBe("arise_complete");

    const ariseCalls = executor.calls.map((call) => `${call.command} ${call.args.join(" ")}`);
    expect(ariseCalls.some((call) => call.includes("devbox arise"))).toBe(true);
    expect(ariseCalls.some((call) => call.includes("devbox status"))).toBe(false);
  });

  test("captures devbox arise failures as server-level job errors", async () => {
    const server = await sshServerManager.createServer({
      name: "Arise Fail Host",
      address: "10.0.0.12",
      username: "remote-user",
      repositoriesBasePath: "/workspaces",
    });
    const executor = new ProvisioningTestExecutor({
      failDevboxArise: true,
    });
    sshServerManager.setExecutorFactoryForTesting(() => executor);

    const manager = new ProvisioningManager(5_000, 500);
    const started = await manager.startJob({
      name: server.config.name,
      sshServerId: server.config.id,
      repoUrl: "",
      basePath: server.config.repositoriesBasePath ?? "",
      provider: "copilot",
      mode: "arise",
    });

    const snapshot = await waitForProvisioningStatus(manager, started.job.config.id, ["failed"]);
    expect(snapshot.job.state.status).toBe("failed");
    expect(snapshot.job.state.error?.code).toBe("devbox_arise_failed");
    expect(snapshot.job.state.error?.message).toContain("Failed to run devbox arise");
  });
});
