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
import { saveWorkerRegistration } from "../../src/persistence/mesh";
import { DEFAULT_EXECUTION_HOST_CAPABILITIES } from "../../src/shared/execution-host";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import { createMockBackend } from "../mocks/mock-backend";
import {
  ProvisioningTestExecutor,
  createDevboxStatusOutput,
} from "../mocks/provisioning-test-executor";
import { pollUntil } from "../helpers/polling";
import { seedTestOwnerUser } from "../setup";

interface ProvisioningSnapshotResponse {
    job: {
      config: {
        id: string;
        executionHostBinding?: {
          host: { kind: string; nodeId?: string; serverId?: string };
          targetKey: string;
          revision: number;
        };
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
    executionHostBinding?: {
      host: { kind: string; nodeId?: string; serverId?: string };
      targetKey: string;
      revision: number;
    };
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
  return pollUntil(
    async () => {
      const response = await fetch(`${baseUrl}/api/provisioning-jobs/${jobId}`);
      expect(response.ok).toBe(true);
      return await response.json() as ProvisioningSnapshotResponse;
    },
    (snapshot) => expectedStatuses.includes(snapshot.job.state.status),
    {
      description: `provisioning job ${jobId} to reach status [${expectedStatuses.join(", ")}]`,
      timeoutMs: 5000,
      formatLastObserved: (snapshot) => `status=${snapshot.job.state.status}`,
    },
  );
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
    backendManager.resetForTesting();
    backendManager.setBackendForTesting(createMockBackend());
    db.run("DELETE FROM tasks");
    db.run("DELETE FROM workspaces");
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

  async function seedMeshExecutionTarget(): Promise<void> {
    seedTestOwnerUser();
    await saveWorkerRegistration({
      workerNodeId: "paired-mesh-node",
      localUserId: "admin",
      workerInstanceName: "Paired mesh node",
      workerEndpoint: "http://127.0.0.1:4100",
      workerTransport: "http",
      workerPublicKey: "paired-mesh-public-key",
      workerFingerprint: "paired-mesh-fingerprint",
      workerEncryptionPublicKey: null,
      workerDirectory: "/devbox/workspaces",
      workerCapabilities: DEFAULT_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
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
        executionHost: { kind: "ssh", serverId: sshServer.config.id },
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

  test("keeps jobs independent across targets and rejects duplicate work", async () => {
    const sshServer = await createServer();
    sshServerManager.setExecutorFactoryForTesting(() => new ProvisioningTestExecutor({
      devboxUpDelayMs: 250,
    }));

    const startJob = async (name: string, repoUrl: string) => await fetch(`${baseUrl}/api/provisioning-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        executionHost: { kind: "ssh", serverId: sshServer.config.id },
        repoUrl,
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

    const firstResponse = await startJob(
      "Parallel Workspace A",
      "https://github.com/octocat/parallel-a.git",
    );
    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json() as ProvisioningSnapshotResponse;

    const duplicateResponse = await startJob(
      "Duplicate Workspace A",
      "https://github.com/octocat/parallel-a.git",
    );
    expect(duplicateResponse.status).toBe(409);
    expect((await duplicateResponse.json() as { error: string }).error).toBe("provisioning_target_busy");

    const secondResponse = await startJob(
      "Parallel Workspace B",
      "https://github.com/octocat/parallel-b.git",
    );
    expect(secondResponse.status).toBe(201);
    const second = await secondResponse.json() as ProvisioningSnapshotResponse;
    expect(second.job.config.id).not.toBe(first.job.config.id);

    const listResponse = await fetch(`${baseUrl}/api/provisioning-jobs`);
    expect(listResponse.ok).toBe(true);
    const listed = await listResponse.json() as {
      jobs: Array<{ config: { id: string } }>;
    };
    expect(listed.jobs.map((job) => job.config.id)).toEqual(
      expect.arrayContaining([first.job.config.id, second.job.config.id]),
    );

    await waitForJobStatus(baseUrl, first.job.config.id, ["completed"]);
    await waitForJobStatus(baseUrl, second.job.config.id, ["completed"]);
  });

  test("provisions through a stdio mesh execution node without an SSH server", async () => {
    await seedMeshExecutionTarget();
    const executor = new ProvisioningTestExecutor({
      devboxStatusOutput: createDevboxStatusOutput({
        workdir: "/devbox/workspaces/mesh-example",
      }),
    });
    backendManager.setExecutorFactoryForTesting(() => executor);

    const response = await fetch(`${baseUrl}/api/provisioning-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Mesh Example",
        executionHost: { kind: "mesh", nodeId: "paired-mesh-node" },
        repoUrl: "https://github.com/octocat/mesh-example.git",
        basePath: "/workspaces",
        devcontainerSubpath: null,
        devboxTemplate: null,
        githubUser: null,
        provider: "copilot",
        credentialToken: null,
        mode: "provision",
        createNewRepository: false,
        targetDirectory: null,
        workspaceId: null,
      }),
    });

    expect(response.status).toBe(201);
    const started = await response.json() as ProvisioningSnapshotResponse;
    expect(started.job.config.executionHostBinding?.host).toEqual({
      kind: "mesh",
      nodeId: "paired-mesh-node",
    });

    const completed = await waitForJobStatus(baseUrl, started.job.config.id, ["completed"]);
    expect(completed.workspace).toMatchObject({
      directory: "/workspaces/mesh-example",
      executionHostBinding: {
        host: {
          kind: "mesh",
          nodeId: "paired-mesh-node",
        },
      },
      serverSettings: {
        agent: {
          provider: "copilot",
        },
      },
    });
  });

  test("never persists provisioning SSH secrets", async () => {
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
        executionHost: { kind: "ssh", serverId: sshServer.config.id },
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
    expect(sensitive.job.state.serverSettings?.agent["password"]).toBeUndefined();
    expect(sensitive.workspace?.serverSettings?.agent["password"]).toBeUndefined();

    provisioningManager.resetForTesting();
    const reloadedSensitiveResponse = await fetch(
      `${baseUrl}/api/provisioning-jobs/${started.job.config.id}?sensitive=true`,
    );
    expect(reloadedSensitiveResponse.ok).toBe(true);
    const reloadedSensitive = await reloadedSensitiveResponse.json() as ProvisioningSnapshotResponse;
    expect(reloadedSensitive.job.state.serverSettings?.agent["password"]).toBeUndefined();
  });

  test("returns 400 for an invalid credential token", async () => {
    const sshServer = await createServer();

    const response = await fetch(`${baseUrl}/api/provisioning-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad Token Workspace",
        executionHost: { kind: "ssh", serverId: sshServer.config.id },
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
        executionHost: { kind: "ssh", serverId: sshServer.config.id },
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
        executionHost: { kind: "ssh", serverId: sshServer.config.id },
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

  test("keeps a failed job for retry and removes it with its logs on dismiss", async () => {
    const sshServer = await createServer();
    sshServerManager.setExecutorFactoryForTesting(() => new ProvisioningTestExecutor({
      failDevboxVersion: true,
    }));

    const requestBody = {
      name: "Retry Workspace",
      executionHost: { kind: "ssh", serverId: sshServer.config.id },
      repoUrl: "https://github.com/octocat/retry.git",
      basePath: "/workspaces",
      devcontainerSubpath: null,
      devboxTemplate: null,
      provider: "copilot",
      credentialToken: null,
      mode: "provision",
      targetDirectory: null,
      workspaceId: null,
    };

    const firstResponse = await fetch(`${baseUrl}/api/provisioning-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json() as ProvisioningSnapshotResponse;
    const failed = await waitForJobStatus(baseUrl, first.job.config.id, ["failed"]);
    expect(failed.job.state.error?.code).toBe("devbox_not_found");

    const retryResponse = await fetch(`${baseUrl}/api/provisioning-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    expect(retryResponse.status).toBe(201);
    const retry = await retryResponse.json() as ProvisioningSnapshotResponse;
    expect(retry.job.config.id).not.toBe(first.job.config.id);

    const listResponse = await fetch(`${baseUrl}/api/provisioning-jobs`);
    expect(listResponse.ok).toBe(true);
    const listed = await listResponse.json() as {
      jobs: Array<{ config: { id: string } }>;
    };
    expect(listed.jobs.map((job) => job.config.id)).toEqual(
      expect.arrayContaining([first.job.config.id, retry.job.config.id]),
    );

    const dismiss = async (): Promise<Response> => {
      const response = await fetch(`${baseUrl}/api/provisioning-jobs/${first.job.config.id}/dismiss`, {
        method: "POST",
      });
      if (response.status === 409) {
        await response.text();
      }
      return response;
    };
    const dismissResponse = await pollUntil(
      dismiss,
      (response) => response.status === 200,
      {
        description: "failed provisioning job to finish finalizing before dismiss",
        timeoutMs: 5000,
        formatLastObserved: (response) => `status=${response.status}`,
      },
    );
    expect(dismissResponse.status).toBe(200);

    const detailAfterDismiss = await fetch(`${baseUrl}/api/provisioning-jobs/${first.job.config.id}`);
    expect(detailAfterDismiss.status).toBe(404);
    const logsAfterDismiss = await fetch(`${baseUrl}/api/provisioning-jobs/${first.job.config.id}/logs`);
    expect(logsAfterDismiss.status).toBe(404);
    const remainingResponse = await fetch(`${baseUrl}/api/provisioning-jobs`);
    const remaining = await remainingResponse.json() as {
      jobs: Array<{ config: { id: string } }>;
    };
    expect(remaining.jobs.map((job) => job.config.id)).not.toContain(first.job.config.id);
    expect(remaining.jobs.map((job) => job.config.id)).toContain(retry.job.config.id);
  });

  test("does not expose another user's provisioning jobs", async () => {
    const sshServer = await createServer();
    sshServerManager.setExecutorFactoryForTesting(() => new ProvisioningTestExecutor({
      failDevboxVersion: true,
    }));

    const response = await fetch(`${baseUrl}/api/provisioning-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Owned Workspace",
        executionHost: { kind: "ssh", serverId: sshServer.config.id },
        repoUrl: "https://github.com/octocat/owned.git",
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
    await waitForJobStatus(baseUrl, started.job.config.id, ["failed"]);

    const otherUser: CurrentUser = {
      id: "other-user",
      username: "other-user",
      role: "user",
      isOwner: false,
      isAdmin: false,
    };
    const otherServer = serveNativeApiRoutes({ user: otherUser });
    const otherBaseUrl = otherServer.url.toString().replace(/\/$/, "");
    try {
      const listResponse = await fetch(`${otherBaseUrl}/api/provisioning-jobs`);
      expect(listResponse.ok).toBe(true);
      expect((await listResponse.json() as { jobs: unknown[] }).jobs).toEqual([]);

      const detailResponse = await fetch(
        `${otherBaseUrl}/api/provisioning-jobs/${started.job.config.id}`,
      );
      expect(detailResponse.status).toBe(404);

      const dismissResponse = await fetch(
        `${otherBaseUrl}/api/provisioning-jobs/${started.job.config.id}/dismiss`,
        { method: "POST" },
      );
      expect(dismissResponse.status).toBe(404);
    } finally {
      otherServer.stop();
    }
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
        executionHost: { kind: "ssh", serverId: sshServer.config.id },
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
