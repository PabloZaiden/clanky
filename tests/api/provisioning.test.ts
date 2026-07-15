import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type Server } from "bun";
import { serveNativeApiRoutes } from "../native-api-server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backendManager } from "../../src/core/backend-manager";
import { provisioningManager } from "../../src/core/provisioning-manager";
import { sshServerManager } from "../../src/core/ssh-server-manager";
import { getDatabase, initializeDatabase } from "../../src/persistence/database";
import type { ProvisioningJobSnapshot } from "@/shared";
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
        devboxTemplate?: string;
        githubUser?: string;
      };
    state: {
      status: string;
      workspaceId?: string;
      serverSettings?: {
        agent: Record<string, unknown>;
      };
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
    serverSettings?: {
      agent: Record<string, unknown>;
    };
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
    dataDir = await mkdtemp(join(tmpdir(), "clanky-provisioning-api-"));
    process.env["CLANKY_DATA_DIR"] = dataDir;
    await initializeDatabase();

    backendManager.setBackendForTesting(createMockBackend());

    server = serveNativeApiRoutes();
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    server.stop();
    sshServerManager.setExecutorFactoryForTesting(null);
    provisioningManager.resetForTesting();
    backendManager.resetForTesting();
    delete process.env["CLANKY_DATA_DIR"];
    await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const db = getDatabase();
    provisioningManager.resetForTesting();
    sshServerManager.setExecutorFactoryForTesting(null);
    db.run("DELETE FROM tasks");
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
    const executor = new ProvisioningTestExecutor({
      devboxStatusOutput: createDevboxStatusOutput({
        workdir: "/workspaces/example",
      }),
    });
    sshServerManager.setExecutorFactoryForTesting(() => executor);

    const response = await fetch(`${baseUrl}/api/provisioning-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Example Workspace",
        sshServerId: sshServer.config.id,
        repoUrl: "https://github.com/octocat/example.git",
        basePath: "/workspaces",
        devcontainerSubpath: ".devcontainer/backend/devcontainer.json",
        devboxTemplate: "python",
        githubUser: " work-account ",
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
    expect(started.job.config.devboxTemplate).toBe("python");
    expect(started.job.config.githubUser).toBe("work-account");
    const completed = await waitForJobStatus(baseUrl, started.job.config.id, ["completed"]);
    expect(completed.job.state.status).toBe("completed");
    expect(completed.job.state.workspaceId).toBeTruthy();
    expect(completed.workspace?.directory).toBe("/workspaces/example");
    const devboxUpCall = executor.calls.find((call) => call.command === "devbox" && call.args[0] === "up");
    expect(devboxUpCall?.args).toEqual(["up", "--template", "python", "--gh-user", "work-account"]);

    const logsResponse = await fetch(`${baseUrl}/api/provisioning-jobs/${started.job.config.id}/logs`);
    expect(logsResponse.ok).toBe(true);
    const logs = await logsResponse.json() as { success: boolean; logs: Array<{ text: string }> };
    expect(logs.success).toBe(true);
    expect(logs.logs.some((entry) => entry.text.includes("Created workspace Example Workspace"))).toBe(true);
  });

  test("omits devbox GitHub user args when githubUser is blank", async () => {
    const sshServer = await createServer();
    const executor = new ProvisioningTestExecutor({
      devboxStatusOutput: createDevboxStatusOutput({
        workdir: "/workspaces/no-gh-user",
      }),
    });
    sshServerManager.setExecutorFactoryForTesting(() => executor);

    const response = await fetch(`${baseUrl}/api/provisioning-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Default GH Workspace",
        sshServerId: sshServer.config.id,
        repoUrl: "https://github.com/octocat/default-gh.git",
        basePath: "/workspaces",
        devcontainerSubpath: "backend",
        devboxTemplate: null,
        githubUser: "   ",
        provider: "copilot",
        credentialToken: null,
        mode: "provision",
        targetDirectory: null,
        workspaceId: null,
      }),
    });

    expect(response.status).toBe(201);
    const started = await response.json() as ProvisioningSnapshotResponse;
    expect(started.job.config.githubUser).toBeUndefined();
    await waitForJobStatus(baseUrl, started.job.config.id, ["completed"]);

    const devboxUpCall = executor.calls.find((call) => call.command === "devbox" && call.args[0] === "up");
    expect(devboxUpCall?.args).toEqual(["up", "--devcontainer-subpath", "backend"]);
  });

  test("hides provisioning SSH secrets by default and includes them with sensitive=true", async () => {
    const sshServer = await createServer();
    sshServerManager.setExecutorFactoryForTesting(() => new ProvisioningTestExecutor({
      devboxStatusOutput: createDevboxStatusOutput({
        workdir: "/workspaces/secure-example",
        password: "runtime-secret",
      }),
    }));

    const response = await fetch(`${baseUrl}/api/provisioning-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Secure Workspace",
        sshServerId: sshServer.config.id,
        repoUrl: "https://github.com/octocat/example.git",
        basePath: "/workspaces",
        devcontainerSubpath: null,
        devboxTemplate: null,
        provider: "copilot",
        credentialToken: null,
        mode: "provision",
        targetDirectory: null,
        workspaceId: null,
      }),
    });

    expect(response.status).toBe(201);
    const started = await response.json() as ProvisioningSnapshotResponse;
    await waitForJobStatus(baseUrl, started.job.config.id, ["completed"]);

    const redactedResponse = await fetch(`${baseUrl}/api/provisioning-jobs/${started.job.config.id}`);
    expect(redactedResponse.ok).toBe(true);
    const redacted = await redactedResponse.json() as ProvisioningSnapshotResponse;
    expect(redacted.job.state.serverSettings?.agent["password"]).toBeUndefined();
    expect(redacted.workspace?.serverSettings?.agent["password"]).toBeUndefined();

    const sensitiveResponse = await fetch(
      `${baseUrl}/api/provisioning-jobs/${started.job.config.id}?sensitive=true`,
    );
    expect(sensitiveResponse.ok).toBe(true);
    const sensitive = await sensitiveResponse.json() as ProvisioningSnapshotResponse;
    expect(sensitive.job.state.serverSettings?.agent["password"]).toBe("runtime-secret");
    expect(sensitive.workspace?.serverSettings?.agent["password"]).toBe("runtime-secret");
  });

  test("redacts provisioning start snapshots by default and includes secrets with sensitive=true", async () => {
    const sshServer = await createServer();
    const snapshot = {
      job: {
        config: {
          id: "job-sensitive-start",
          name: "Sensitive Start",
          sshServerId: sshServer.config.id,
          repoUrl: "https://github.com/octocat/example.git",
          basePath: "/workspaces",
          provider: "copilot" as const,
          mode: "restart" as const,
          targetDirectory: "/workspaces/existing",
          workspaceId: "workspace-sensitive",
          createdAt: new Date().toISOString(),
        },
        state: {
          status: "running",
          workspaceId: "workspace-sensitive",
          updatedAt: new Date().toISOString(),
          serverSettings: {
            agent: {
              provider: "copilot" as const,
              transport: "ssh" as const,
              hostname: "ssh.example.com",
              port: 2222,
              username: "deploy",
              password: "route-secret",
            },
          },
        },
      },
      logs: [],
      workspace: {
        id: "workspace-sensitive",
        name: "Sensitive Workspace",
        directory: "/workspaces/existing",
        serverSettings: {
          agent: {
            provider: "copilot" as const,
            transport: "ssh" as const,
            hostname: "ssh.example.com",
            port: 2222,
            username: "deploy",
            password: "route-secret",
            identityFile: "/keys/id_ed25519",
          },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    } satisfies ProvisioningJobSnapshot;

    const originalStartJob = provisioningManager.startJob;
    provisioningManager.startJob = async () => snapshot;

    try {
      const requestBody = {
        name: "Sensitive Start",
        sshServerId: sshServer.config.id,
        repoUrl: "https://github.com/octocat/example.git",
        basePath: "/workspaces",
        devcontainerSubpath: null,
        devboxTemplate: null,
        provider: "copilot" as const,
        credentialToken: null,
        mode: "restart" as const,
        targetDirectory: "/workspaces/existing",
        workspaceId: "workspace-sensitive",
      };

      const defaultResponse = await fetch(`${baseUrl}/api/provisioning-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      expect(defaultResponse.status).toBe(201);
      const redacted = await defaultResponse.json() as ProvisioningSnapshotResponse;
      expect(redacted.job.state.serverSettings?.agent["password"]).toBeUndefined();
      expect(redacted.workspace?.serverSettings?.agent["password"]).toBeUndefined();
      expect(redacted.workspace?.serverSettings?.agent["identityFile"]).toBeUndefined();

      const sensitiveResponse = await fetch(`${baseUrl}/api/provisioning-jobs?sensitive=true`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      expect(sensitiveResponse.status).toBe(201);
      const sensitive = await sensitiveResponse.json() as ProvisioningSnapshotResponse;
      expect(sensitive.job.state.serverSettings?.agent["password"]).toBe("route-secret");
      expect(sensitive.workspace?.serverSettings?.agent["password"]).toBe("route-secret");
      expect(sensitive.workspace?.serverSettings?.agent["identityFile"]).toBe("/keys/id_ed25519");
    } finally {
      provisioningManager.startJob = originalStartJob;
    }
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
        devboxTemplate: null,
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
        devboxTemplate: null,
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
        devboxTemplate: null,
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
        devboxTemplate: null,
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
        devboxTemplate: null,
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
