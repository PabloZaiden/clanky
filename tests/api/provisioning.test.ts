import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { serve, type Server } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiRoutes } from "../../src/api";
import { backendManager } from "../../src/core/backend-manager";
import { provisioningManager } from "../../src/core/provisioning-manager";
import { sshServerManager } from "../../src/core/ssh-server-manager";
import { ensureDataDirectories, getDatabase } from "../../src/persistence/database";
import { createMockBackend } from "../mocks/mock-backend";
import {
  ProvisioningTestExecutor,
  createDevboxStatusOutput,
} from "../mocks/provisioning-test-executor";

interface ProvisioningSnapshotResponse {
  job: {
    config: {
      id: string;
      devcontainerSubpath?: string;
    };
    state: {
      status: string;
      workspaceId?: string;
      error?: {
        code: string;
        message: string;
      };
    };
  };
  logs: Array<{ text: string }>;
  workspace?: {
    id: string;
    directory: string;
  };
}

async function waitForJobStatus(
  baseUrl: string,
  jobId: string,
  expectedStatuses: string[],
): Promise<ProvisioningSnapshotResponse> {
  const deadline = Date.now() + 5000;
  let lastSnapshot: ProvisioningSnapshotResponse | null = null;

  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/provisioning-jobs/${jobId}`);
    expect(response.ok).toBe(true);
    lastSnapshot = await response.json() as ProvisioningSnapshotResponse;
    if (expectedStatuses.includes(lastSnapshot.job.state.status)) {
      return lastSnapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for provisioning job ${jobId}. Last snapshot: ${JSON.stringify(lastSnapshot)}`);
}

describe("Provisioning API integration", () => {
  let dataDir: string;
  let server: Server<unknown>;
  let baseUrl: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ralpher-provisioning-api-"));
    process.env["RALPHER_DATA_DIR"] = dataDir;
    await ensureDataDirectories();

    backendManager.setBackendForTesting(createMockBackend());

    server = serve({
      port: 0,
      routes: {
        ...apiRoutes,
      },
    });
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    server.stop();
    sshServerManager.setExecutorFactoryForTesting(null);
    provisioningManager.resetForTesting();
    backendManager.resetForTesting();
    delete process.env["RALPHER_DATA_DIR"];
    await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const db = getDatabase();
    provisioningManager.resetForTesting();
    sshServerManager.setExecutorFactoryForTesting(null);
    db.run("DELETE FROM loops");
    db.run("DELETE FROM workspaces");
    db.run("DELETE FROM ssh_server_sessions");
    db.run("DELETE FROM ssh_servers");
  });

  async function createServer() {
    return await sshServerManager.createServer({
      name: "Shared host",
      address: "ssh.example.com",
      username: "deploy",
      repositoriesBasePath: null,
    });
  }

  test("creates a provisioning job and completes with a workspace snapshot", async () => {
    const sshServer = await createServer();
    sshServerManager.setExecutorFactoryForTesting(() => new ProvisioningTestExecutor({
      devboxStatusOutput: createDevboxStatusOutput({
        workdir: "/workspaces/example",
      }),
    }));

    const response = await fetch(`${baseUrl}/api/provisioning-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Example Workspace",
        sshServerId: sshServer.config.id,
        repoUrl: "https://github.com/octocat/example.git",
        basePath: "/workspaces",
        devcontainerSubpath: ".devcontainer/backend/devcontainer.json",
        provider: "copilot",
        credentialToken: null,
        mode: "provision",
        targetDirectory: null,
        workspaceId: null,
      }),
    });

    expect(response.status).toBe(201);
    const started = await response.json() as ProvisioningSnapshotResponse;
    expect(started.job.config.devcontainerSubpath).toBe(".devcontainer/backend/devcontainer.json");
    const completed = await waitForJobStatus(baseUrl, started.job.config.id, ["completed"]);
    expect(completed.job.state.status).toBe("completed");
    expect(completed.job.state.workspaceId).toBeTruthy();
    expect(completed.workspace?.directory).toBe("/workspaces/example");

    const logsResponse = await fetch(`${baseUrl}/api/provisioning-jobs/${started.job.config.id}/logs`);
    expect(logsResponse.ok).toBe(true);
    const logs = await logsResponse.json() as { success: boolean; logs: Array<{ text: string }> };
    expect(logs.success).toBe(true);
    expect(logs.logs.some((entry) => entry.text.includes("Created workspace Example Workspace"))).toBe(true);
  });

  test("returns 404 when the SSH server does not exist", async () => {
    const response = await fetch(`${baseUrl}/api/provisioning-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Missing Server Workspace",
        sshServerId: "missing-server",
        repoUrl: "https://github.com/octocat/example.git",
        basePath: "/workspaces",
        devcontainerSubpath: null,
        provider: "copilot",
        credentialToken: null,
        mode: "provision",
        targetDirectory: null,
        workspaceId: null,
      }),
    });

    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("returns 400 for an invalid credential token", async () => {
    const sshServer = await createServer();

    const response = await fetch(`${baseUrl}/api/provisioning-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad Token Workspace",
        sshServerId: sshServer.config.id,
        repoUrl: "https://github.com/octocat/example.git",
        basePath: "/workspaces",
        devcontainerSubpath: null,
        provider: "copilot",
        credentialToken: "invalid-token",
        mode: "provision",
        targetDirectory: null,
        workspaceId: null,
      }),
    });

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_credential_token");
  });

  test("can cancel an in-flight provisioning job", async () => {
    const sshServer = await createServer();
    sshServerManager.setExecutorFactoryForTesting(() => new ProvisioningTestExecutor({
      devboxUpDelayMs: 500,
    }));

    const response = await fetch(`${baseUrl}/api/provisioning-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Slow Workspace",
        sshServerId: sshServer.config.id,
        repoUrl: "https://github.com/octocat/example.git",
        basePath: "/workspaces",
        devcontainerSubpath: null,
        provider: "copilot",
        credentialToken: null,
        mode: "provision",
        targetDirectory: null,
        workspaceId: null,
      }),
    });

    expect(response.status).toBe(201);
    const started = await response.json() as ProvisioningSnapshotResponse;

    const cancelResponse = await fetch(`${baseUrl}/api/provisioning-jobs/${started.job.config.id}`, {
      method: "DELETE",
    });
    expect(cancelResponse.ok).toBe(true);

    const cancelled = await waitForJobStatus(baseUrl, started.job.config.id, ["cancelled"]);
    expect(cancelled.job.state.status).toBe("cancelled");
    expect(cancelled.job.state.error?.code).toBe("cancelled");
  });

  test("captures provisioning failures in job state", async () => {
    const sshServer = await createServer();
    sshServerManager.setExecutorFactoryForTesting(() => new ProvisioningTestExecutor({
      failDevboxVersion: true,
    }));

    const response = await fetch(`${baseUrl}/api/provisioning-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Broken Workspace",
        sshServerId: sshServer.config.id,
        repoUrl: "https://github.com/octocat/example.git",
        basePath: "/workspaces",
        devcontainerSubpath: null,
        provider: "copilot",
        credentialToken: null,
        mode: "provision",
        targetDirectory: null,
        workspaceId: null,
      }),
    });

    expect(response.status).toBe(201);
    const started = await response.json() as ProvisioningSnapshotResponse;
    const failed = await waitForJobStatus(baseUrl, started.job.config.id, ["failed"]);
    expect(failed.job.state.status).toBe("failed");
    expect(failed.job.state.error?.code).toBe("devbox_not_found");
    expect(failed.job.state.error?.message).toContain("Devbox is not installed or not available on PATH");
  });

  test("creates and completes a server-level arise job without workspace fields", async () => {
    const sshServer = await sshServerManager.createServer({
      name: "Arise Host",
      address: "ssh.example.com",
      username: "deploy",
      repositoriesBasePath: "/workspaces",
    });
    sshServerManager.setExecutorFactoryForTesting(() => new ProvisioningTestExecutor());

    const response = await fetch(`${baseUrl}/api/provisioning-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: sshServer.config.name,
        sshServerId: sshServer.config.id,
        repoUrl: "",
        basePath: "",
        devcontainerSubpath: null,
        provider: "copilot",
        credentialToken: null,
        mode: "arise",
        targetDirectory: null,
        workspaceId: null,
      }),
    });

    expect(response.status).toBe(201);
    const started = await response.json() as ProvisioningSnapshotResponse;
    const completed = await waitForJobStatus(baseUrl, started.job.config.id, ["completed"]);
    expect(completed.job.state.status).toBe("completed");
    expect(completed.job.state.workspaceId).toBeUndefined();
    expect(completed.logs.some((entry) => entry.text.includes("Devbox arise completed successfully"))).toBe(true);
  });
});
