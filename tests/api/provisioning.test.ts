import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type Server } from "bun";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { serveNativeApiRoutes } from "../native-api-server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backendManager } from "../../src/core/backend-manager";
import { provisioningManager } from "../../src/core/provisioning-manager";
import { sshServerManager } from "../../src/core/ssh-server-manager";
import { workspaceWorkerEnrollmentService } from "../../src/core/workspace-worker-enrollment-service";
import { getDatabase, initializeDatabase } from "../../src/persistence/database";
import {
  getWorkerRegistrationByWorkspace,
  saveWorkerRegistration,
} from "../../src/persistence/mesh";
import { ensureMeshWorkerTlsIdentity } from "../../src/persistence/mesh-worker-tls";
import {
  ensureLocalMeshNodeIdentity,
  getMeshNodeFingerprint,
} from "../../src/persistence/mesh-node-identity";
import { saveControllerRelayPairing } from "../../src/persistence/controller-relay-pairing";
import { buildMeshHealthCheckResponseSigningPayload } from "../../src/core/mesh-protocol";
import { setMeshRelayTransport } from "../../src/core/mesh-peer-transport";
import { POSIX_EXECUTION_HOST_CAPABILITIES } from "../../src/shared/execution-host";
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
        transport?: string;
        workerEnrollmentId?: string;
        workerEnrollmentRoute?: "direct" | "relay";
        workerHostAddress?: string;
        workerHostAddressManual?: boolean;
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
  logs: Array<{ text: string; step?: string }>;
  workspace?: {
    id: string;
    directory: string;
    executionHostBinding?: {
      host: { kind: string; scope?: string; workspaceId?: string; nodeId?: string; serverId?: string };
      targetKey: string;
      revision: number;
    };
    provisioningHostBinding?: {
      host: { kind: string; scope?: string; workspaceId?: string; nodeId?: string; serverId?: string };
      targetKey: string;
      revision: number;
    };
    sshTarget?: {
      kind: string;
      host: string;
      port: number;
      username: string;
      credentialConfigured: boolean;
      password?: string;
    };
    serverSettings?: {
      agent: Record<string, unknown>;
    };
  };
}

interface MeshHealthResponder {
  setWorker(workerNodeId: string, privateKey: KeyObject): void;
  failNextHealthChecks(count: number): void;
  getStats(): { requests: number; failures: number; successes: number };
  restore(): void;
}

function installMeshHealthResponder(): MeshHealthResponder {
  const originalFetch = globalThis.fetch;
  let workerNodeId: string | undefined;
  let workerPrivateKey: KeyObject | undefined;
  let failuresRemaining = 0;
  let requests = 0;
  let failures = 0;
  let successes = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    if (!url.endsWith("/api/mesh/internal/health")) {
      return await originalFetch(input, init);
    }

    requests++;
    if (failuresRemaining > 0) {
      failuresRemaining--;
      failures++;
      throw new TypeError("worker is still starting");
    }
    if (!workerNodeId || !workerPrivateKey) {
      throw new Error("Mesh health responder is missing its worker identity");
    }

    const request = new Request(input, init);
    const body = await request.json() as { senderNodeId: string; nonce: string };
    const unsignedResponse = {
      protocolVersion: 1 as const,
      workerNodeId,
      controllerNodeId: body.senderNodeId,
      requestNonce: body.nonce,
      workerDirectory: "/workspaces/worker-example",
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
    };
    const response = {
      ...unsignedResponse,
      signature: sign(
        null,
        Buffer.from(buildMeshHealthCheckResponseSigningPayload(unsignedResponse)),
        workerPrivateKey,
      ).toString("base64url"),
    };
    successes++;
    return Response.json(response);
  }) as typeof fetch;

  return {
    setWorker(nextWorkerNodeId, nextWorkerPrivateKey) {
      workerNodeId = nextWorkerNodeId;
      workerPrivateKey = nextWorkerPrivateKey;
    },
    failNextHealthChecks(count) {
      failuresRemaining = count;
    },
    getStats() {
      return { requests, failures, successes };
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
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
      formatLastObserved: (snapshot) =>
        `status=${snapshot.job.state.status}, error=${
          snapshot.job.state.error
            ? JSON.stringify(snapshot.job.state.error)
            : "none"
        }`,
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
    db.run("DELETE FROM mesh_controller_relay_pairing");
    setMeshRelayTransport(null);
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
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/devbox/workspaces",
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
    });
  }

  async function seedDedicatedMeshExecutionTarget(): Promise<string> {
    seedTestOwnerUser();
    const workerNodeId = `dedicated-mesh-node-${crypto.randomUUID()}`;
    const enrollment = workspaceWorkerEnrollmentService.create("admin", {
      name: "Dedicated provisioning worker",
      ttlSeconds: 900,
      controller: {
        nodeId: "controller-node",
        fingerprint: "controller-fingerprint",
      },
    });
    await saveWorkerRegistration({
      workerNodeId,
      localUserId: "admin",
      workerInstanceName: "Dedicated provisioning worker",
      workerEndpoint: "http://127.0.0.1:4100",
      workerTransport: "http",
      workerPublicKey: `${workerNodeId}-public-key`,
      workerFingerprint: `${workerNodeId}-fingerprint`,
      workerEncryptionPublicKey: null,
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/devbox/workspaces",
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
      registrationScope: "workspace",
      workspaceWorkerEnrollmentId: enrollment.enrollment.id,
    });
    workspaceWorkerEnrollmentService.markConnected(
      "admin",
      enrollment.enrollment.id,
      workerNodeId,
    );
    return enrollment.enrollment.id;
  }

  test("creates a provisioning job and completes with a workspace snapshot", async () => {
    const sshServer = await createServer();
    const executor = new ProvisioningTestExecutor({
      devboxVersion: "1.2.2",
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
        transport: "ssh",
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
    expect(devboxUpCall?.args).toEqual(["up", "--ssh", "--template", "python", "--gh-user", "work-account"]);

    const logsResponse = await fetch(`${baseUrl}/api/provisioning-jobs/${started.job.config.id}/logs`);
    expect(logsResponse.ok).toBe(true);
    const logs = await logsResponse.json() as { success: boolean; logs: Array<{ text: string }> };
    expect(logs.success).toBe(true);
    expect(logs.logs.some((entry) => entry.text.includes("Created workspace Example Workspace"))).toBe(true);
  });

  test("requires a worker host address when provision transport defaults to worker", async () => {
    const sshServer = await createServer();
    const response = await fetch(`${baseUrl}/api/provisioning-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Missing Worker Address",
        executionHost: { kind: "ssh", serverId: sshServer.config.id },
        repoUrl: "https://github.com/octocat/missing-worker-address.git",
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

    expect(response.status).toBe(400);
  });

  test("rejects a GitHub SSH URL that contains only the username prefix", async () => {
    const sshServer = await createServer();
    const response = await fetch(`${baseUrl}/api/provisioning-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Incomplete Repository",
        executionHost: { kind: "ssh", serverId: sshServer.config.id },
        transport: "ssh",
        repoUrl: "git@github.com:octocat/",
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

    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe("validation_error");
  });

  test("rejects a worker host address that is not discovered on the execution host", async () => {
    const sshServer = await createServer();
    sshServerManager.setExecutorFactoryForTesting(() => new ProvisioningTestExecutor());

    const response = await fetch(`${baseUrl}/api/provisioning-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Unknown Worker Address",
        executionHost: { kind: "ssh", serverId: sshServer.config.id },
        transport: "worker",
        workerHostAddress: "192.168.1.21",
        repoUrl: "https://github.com/octocat/unknown-worker-address.git",
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

    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe("invalid_worker_host_address");
  });

  test("rejects a manually entered worker host containing spaces", async () => {
    const sshServer = await createServer();
    const response = await fetch(`${baseUrl}/api/provisioning-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Invalid Worker Host",
        executionHost: { kind: "ssh", serverId: sshServer.config.id },
        transport: "worker",
        workerHostAddress: "worker host.example.test",
        workerHostAddressManual: true,
        repoUrl: "https://github.com/octocat/invalid-worker-host.git",
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

    expect(response.status).toBe(400);
  });

  test("provisions an automatic workspace through a dedicated HTTPS worker", async () => {
    const previousPublicBaseUrl = process.env["CLANKY_PUBLIC_BASE_URL"];
    process.env["CLANKY_PUBLIC_BASE_URL"] = "https://clanky.example.test";
    const healthResponder = installMeshHealthResponder();
    try {
      const controller = await ensureLocalMeshNodeIdentity();
      const relayKeys = generateKeyPairSync("ed25519");
      const relayPublicKey = relayKeys.publicKey
        .export({ format: "pem", type: "spki" })
        .toString();
      saveControllerRelayPairing({
        relayUrl: "https://relay.example.test",
        relayPublicKey,
        relayFingerprint: getMeshNodeFingerprint(relayPublicKey),
        controllerNodeId: controller.nodeId,
        controllerFingerprint: controller.fingerprint,
      });
      const sshServer = await createServer();
      const manualWorkerHost = "worker.example.test";
      const executor = new ProvisioningTestExecutor({
        devboxStatusOutput: createDevboxStatusOutput({
          running: true,
          sshEnabled: false,
          password: null,
          sshUser: null,
          sshPort: null,
          workdir: "/workspaces/worker-example",
          ports: [5001],
          publishedPorts: {
            "5001/tcp": [
              {
                hostIp: "0.0.0.0",
                hostPort: 5001,
              },
            ],
          },
        }),
        onWorkerJoin: async () => {
          const enrollment = workspaceWorkerEnrollmentService.list("admin")
            .find((candidate) => candidate.enrollment.name === "Worker Workspace worker");
          expect(enrollment).toBeTruthy();
          const workerNodeId = `automatic-worker-${crypto.randomUUID()}`;
          const workerEndpoint = `https://${manualWorkerHost}:5001`;
          const workerTlsIdentity = await ensureMeshWorkerTlsIdentity(workerEndpoint);
          const workerKeys = generateKeyPairSync("ed25519");
          const workerPublicKey = workerKeys.publicKey
            .export({ format: "pem", type: "spki" })
            .toString();
          healthResponder.setWorker(workerNodeId, workerKeys.privateKey);
          await saveWorkerRegistration({
            workerNodeId,
            localUserId: "admin",
            workerInstanceName: "Worker Workspace worker",
            workerEndpoint,
            workerTransport: "https",
            workerPublicKey,
            workerFingerprint: getMeshNodeFingerprint(workerPublicKey),
            workerEncryptionPublicKey: null,
            workerTlsCertificate: workerTlsIdentity.certificate,
            workerTlsFingerprint: workerTlsIdentity.fingerprint,
            workerDirectory: "/workspaces/worker-example",
            workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
            workerAcceptRemoteExecution: true,
            workerConfigRevision: 1,
            registrationScope: "workspace",
            workspaceWorkerEnrollmentId: enrollment!.enrollment.id,
          });

          workspaceWorkerEnrollmentService.markConnected(
            "admin",
            enrollment!.enrollment.id,
            workerNodeId,
          );
          healthResponder.failNextHealthChecks(2);
        },
      });
      sshServerManager.setExecutorFactoryForTesting(() => executor);

      const response = await fetch(`${baseUrl}/api/provisioning-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Worker Workspace",
          executionHost: { kind: "ssh", serverId: sshServer.config.id },
          workerEnrollmentRoute: "direct",
          workerHostAddress: manualWorkerHost,
          workerHostAddressManual: true,
          repoUrl: "https://github.com/octocat/worker-example.git",
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
      expect(started.job.config.transport).toBe("worker");
      expect(started.job.config.workerEnrollmentRoute).toBe("direct");
      expect(started.job.config.workerHostAddress).toBe(manualWorkerHost);
      expect(started.job.config.workerHostAddressManual).toBe(true);

      const completed = await waitForJobStatus(baseUrl, started.job.config.id, ["completed"]);
      expect(healthResponder.getStats()).toMatchObject({
        failures: 2,
        successes: 1,
      });
      expect(completed.job.config.workerEnrollmentId).toBeTruthy();
      expect(
        completed.logs.find((entry) => entry.text.includes("Bootstrapping the workspace worker"))?.step,
      ).toBe("devbox_up");
      expect(completed.workspace?.executionHostBinding?.host).toMatchObject({
        kind: "mesh",
        scope: "workspace",
        workspaceId: completed.workspace?.id,
      });
      expect(completed.workspace?.provisioningHostBinding?.host).toMatchObject({
        kind: "ssh",
        serverId: sshServer.config.id,
      });
      expect(executor.calls.some((call) =>
        call.command === "devbox"
        && call.args[0] === "up"
        && call.args.includes("--no-ssh")
        && call.args.includes("--ports")
        && call.args.includes("1")
        && call.args.includes("--no-startup-command"),
      )).toBe(true);
      expect(executor.calls.some((call) =>
        call.command === "devbox"
        && call.args[0] === "up"
        && call.args.includes("--no-ssh")
        && call.args.includes("--ports")
        && call.args.includes("1")
        && call.args.includes("--startup-command")
        && call.args.some((arg) =>
          arg.includes("/workspaces/worker-example/.devbox/clanky-worker/launcher.sh"),
        ),
      )).toBe(true);
      expect(executor.calls.some((call) =>
        call.command === "chmod"
        && call.args[0] === "1777"
        && call.args.some((arg) => arg.endsWith("/.devbox/clanky-worker")),
      )).toBe(true);
      expect(executor.calls.some((call) =>
        call.command === "chmod"
        && call.args[0] === "755"
        && call.args.some((arg) => arg.endsWith("/.devbox/clanky-worker/launcher.sh")),
      )).toBe(true);
      const launcher = await executor.readFile(
        "/workspaces/worker-example/.devbox/clanky-worker/launcher.sh",
      );
      expect(launcher).toBeTruthy();
      expect(launcher ?? "").toContain(
        "https://raw.githubusercontent.com/pablozaiden/installer/1e73c9a4b84bb2282d5a6fd8463f9a9f62c26c67/install.sh",
      );
      expect(launcher ?? "").toContain(
        "d377a7ed04b150781b94cb0af97e6f7a2efe2c8d12dae1a1f0aa825306ea28f3",
      );
      expect(launcher ?? "").toContain("sha256sum -c -");
      expect(executor.calls.some((call) =>
        call.command === "devbox"
        && call.args[0] === "exec"
        && call.args.includes("bootstrap"),
      )).toBe(true);
      expect(executor.calls.some((call) =>
        call.command === "devbox"
        && call.args[0] === "exec"
        && call.args.some((arg) => arg.includes("worker join")),
      )).toBe(true);

      const registrationBeforeRestart = getWorkerRegistrationByWorkspace(
        completed.workspace!.id,
        "admin",
      );
      expect(registrationBeforeRestart?.workerEndpoint).toBe("https://worker.example.test:5001");

      const restartExecutor = new ProvisioningTestExecutor({
        existingDirectories: ["/workspaces/worker-example"],
        devboxStatusOutput: createDevboxStatusOutput({
          sshEnabled: false,
          password: null,
          sshUser: null,
          sshPort: null,
          workdir: "/workspaces/worker-example",
          ports: [5002],
          publishedPorts: {
            "5002/tcp": [
              {
                hostIp: "0.0.0.0",
                hostPort: 5002,
              },
            ],
          },
        }),
      });
      sshServerManager.setExecutorFactoryForTesting(() => restartExecutor);
      healthResponder.failNextHealthChecks(2);

      const restartResponse = await fetch(`${baseUrl}/api/provisioning-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Worker Workspace",
          executionHost: { kind: "ssh", serverId: sshServer.config.id },
          repoUrl: "",
          basePath: "/workspaces",
          devcontainerSubpath: null,
          devboxTemplate: null,
          githubUser: null,
          provider: "copilot",
          credentialToken: null,
          mode: "restart",
          targetDirectory: "/workspaces/worker-example",
          workspaceId: completed.workspace!.id,
        }),
      });
      expect(restartResponse.status).toBe(201);
      const startedRestart = await restartResponse.json() as ProvisioningSnapshotResponse;
      expect(startedRestart.job.config.transport).toBe("worker");
      const completedRestart = await waitForJobStatus(
        baseUrl,
        startedRestart.job.config.id,
        ["completed"],
      );
      expect(healthResponder.getStats().failures).toBe(4);
      expect(healthResponder.getStats().successes).toBe(2);
      expect(completedRestart.workspace?.executionHostBinding?.host).toMatchObject({
        kind: "mesh",
        scope: "workspace",
        workspaceId: completed.workspace!.id,
      });
      expect(getWorkerRegistrationByWorkspace(completed.workspace!.id, "admin")?.workerEndpoint)
        .toBe("https://worker.example.test:5002");

      const deleted = await fetch(
        `${baseUrl}/api/workspaces/${completed.workspace?.id}`,
        { method: "DELETE", body: JSON.stringify({}) },
      );
      expect(deleted.status).toBe(200);
    } finally {
      healthResponder.restore();
      if (previousPublicBaseUrl === undefined) {
        delete process.env["CLANKY_PUBLIC_BASE_URL"];
      } else {
        process.env["CLANKY_PUBLIC_BASE_URL"] = previousPublicBaseUrl;
      }
    }
  });

  test("rolls back a worker enrollment when worker registration fails", async () => {
    const previousPublicBaseUrl = process.env["CLANKY_PUBLIC_BASE_URL"];
    process.env["CLANKY_PUBLIC_BASE_URL"] = "https://clanky.example.test";
    try {
      const sshServer = await createServer();
      const executor = new ProvisioningTestExecutor({
        failWorkerJoin: true,
        devboxStatusOutput: createDevboxStatusOutput({
          sshEnabled: false,
          password: null,
          sshUser: null,
          sshPort: null,
          workdir: "/workspaces/failed-worker",
          ports: [5001],
          publishedPorts: {
            "5001/tcp": [{ hostIp: "0.0.0.0", hostPort: 5001 }],
          },
        }),
      });
      sshServerManager.setExecutorFactoryForTesting(() => executor);

      const response = await fetch(`${baseUrl}/api/provisioning-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Failed Worker",
          executionHost: { kind: "ssh", serverId: sshServer.config.id },
          workerHostAddress: "worker.example.test",
          workerHostAddressManual: true,
          repoUrl: "https://github.com/octocat/failed-worker.git",
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
      expect(failed.job.state.error?.code).toBe("worker_join_failed");
      expect(failed.workspace).toBeUndefined();
      const joinIndex = executor.calls.findIndex((call) =>
        call.command === "devbox"
        && call.args[0] === "exec"
        && call.args.some((arg) => arg.includes("worker join"))
      );
      const processCleanupIndex = executor.calls.findIndex((call) =>
        call.command === "sh"
        && call.args.some((arg) => arg.includes(".devbox/clanky-worker/worker.pid"))
      );
      expect(joinIndex).toBeGreaterThan(-1);
      expect(processCleanupIndex).toBeGreaterThan(joinIndex);

      const enrollment = workspaceWorkerEnrollmentService.list("admin")
        .find((candidate) => candidate.enrollment.name === "Failed Worker worker");
      expect(enrollment?.enrollment.status).toBe("cancelled");
      expect(enrollment?.enrollment.errorCode).toBe("enrollment_cancelled");
    } finally {
      if (previousPublicBaseUrl === undefined) {
        delete process.env["CLANKY_PUBLIC_BASE_URL"];
      } else {
        process.env["CLANKY_PUBLIC_BASE_URL"] = previousPublicBaseUrl;
      }
    }
  });

  test("releases an externally supplied worker claim when provisioning fails early", async () => {
    const workspaceWorkerEnrollmentId = await seedDedicatedMeshExecutionTarget();
    const executor = new ProvisioningTestExecutor({
      failDevboxVersion: true,
    });
    backendManager.setExecutorFactoryForTesting(() => executor);

    const response = await fetch(`${baseUrl}/api/provisioning-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Early Failure Dedicated Worker",
        workspaceWorkerEnrollmentId,
        transport: "ssh",
        repoUrl: "https://github.com/octocat/early-failure.git",
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
    const failed = await waitForJobStatus(baseUrl, started.job.config.id, ["failed"]);
    expect(failed.job.state.error?.code).toBe("devbox_not_found");

    const enrollment = workspaceWorkerEnrollmentService.getStatus(
      "admin",
      workspaceWorkerEnrollmentId,
    );
    expect(enrollment.enrollment.status).toBe("connected");
    expect(enrollment.enrollment.claimedBy).toBeNull();
    expect(enrollment.enrollment.workspaceId).toBeNull();
  });

  test("defaults a paired controller to a relay-only dedicated worker", async () => {
    const previousPublicBaseUrl = process.env["CLANKY_PUBLIC_BASE_URL"];
    process.env["CLANKY_PUBLIC_BASE_URL"] = "https://clanky.example.test";
    const relayUrl = "https://relay.example.test";
    const relayKeys = generateKeyPairSync("ed25519");
    const relayPublicKey = relayKeys.publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    const relayFingerprint = getMeshNodeFingerprint(relayPublicKey);
    const controller = await ensureLocalMeshNodeIdentity();
    saveControllerRelayPairing({
      relayUrl,
      relayPublicKey,
      relayFingerprint,
      controllerNodeId: controller.nodeId,
      controllerFingerprint: controller.fingerprint,
    });

    let workerNodeId = "";
    let workerPrivateKey: KeyObject | undefined;
    setMeshRelayTransport({
      async request(route, path, request): Promise<Response> {
        expect(route).toMatchObject({
          kind: "relay",
          relayUrl,
          relayFingerprint,
        });
        expect(path).toBe("api/mesh/internal/health");
        const body = JSON.parse(String(request.body)) as {
          senderNodeId: string;
          nonce: string;
        };
        const unsignedResponse = {
          protocolVersion: 1 as const,
          workerNodeId,
          controllerNodeId: body.senderNodeId,
          requestNonce: body.nonce,
          workerDirectory: "/workspaces/relay-example",
          workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
          workerAcceptRemoteExecution: true,
          workerConfigRevision: 1,
        };
        return Response.json({
          ...unsignedResponse,
          signature: sign(
            null,
            Buffer.from(buildMeshHealthCheckResponseSigningPayload(unsignedResponse)),
            workerPrivateKey!,
          ).toString("base64url"),
        });
      },
      openSocket(): never {
        throw new Error("Socket transport is not used by this provisioning scenario.");
      },
    });
    try {
      const sshServer = await createServer();
      const executor = new ProvisioningTestExecutor({
        devboxStatusOutput: createDevboxStatusOutput({
          running: true,
          sshEnabled: false,
          password: null,
          sshUser: null,
          sshPort: null,
          workdir: "/workspaces/relay-example",
          ports: [],
          publishedPorts: {},
        }),
        onWorkerJoin: async () => {
          const enrollment = workspaceWorkerEnrollmentService.list("admin")
            .find((candidate) => candidate.enrollment.name === "Relay Workspace worker");
          expect(enrollment).toBeTruthy();
          const workerKeys = generateKeyPairSync("ed25519");
          workerPrivateKey = workerKeys.privateKey;
          workerNodeId = `relay-worker-${crypto.randomUUID()}`;
          const workerPublicKey = workerKeys.publicKey
            .export({ format: "pem", type: "spki" })
            .toString();
          await saveWorkerRegistration({
            workerNodeId,
            localUserId: "admin",
            workerInstanceName: "Relay Workspace worker",
            workerEndpoint: relayUrl,
            workerTransport: "https",
            workerPublicKey,
            workerFingerprint: getMeshNodeFingerprint(workerPublicKey),
            workerEncryptionPublicKey: null,
            workerTlsCertificate: null,
            workerTlsFingerprint: null,
            route: {
              kind: "relay",
              targetNodeId: workerNodeId,
              relayUrl,
              relayFingerprint,
            },
            workerDirectory: "/workspaces/relay-example",
            workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
            workerAcceptRemoteExecution: true,
            workerConfigRevision: 1,
            registrationScope: "workspace",
            workspaceWorkerEnrollmentId: enrollment!.enrollment.id,
          });
          workspaceWorkerEnrollmentService.markConnected(
            "admin",
            enrollment!.enrollment.id,
            workerNodeId,
          );
        },
      });
      sshServerManager.setExecutorFactoryForTesting(() => executor);

      const response = await fetch(`${baseUrl}/api/provisioning-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Relay Workspace",
          executionHost: { kind: "ssh", serverId: sshServer.config.id },
          repoUrl: "https://github.com/octocat/relay-example.git",
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
      expect(started.job.config).toMatchObject({
        transport: "worker",
        workerEnrollmentRoute: "relay",
      });
      expect(started.job.config.workerHostAddress).toBeUndefined();

      const completed = await waitForJobStatus(
        baseUrl,
        started.job.config.id,
        ["completed"],
      );
      expect(completed.workspace?.executionHostBinding?.host).toMatchObject({
        kind: "mesh",
        scope: "workspace",
        nodeId: workerNodeId,
      });
      const upCalls = executor.calls.filter(
        (call) => call.command === "devbox" && call.args[0] === "up",
      );
      expect(upCalls.length).toBeGreaterThan(0);
      expect(upCalls.every((call) => !call.args.includes("--ports"))).toBe(true);
      const bootstrapCall = executor.calls.find((call) =>
        call.command === "devbox"
        && call.args[0] === "exec"
        && call.args.includes("bootstrap")
      );
      expect(bootstrapCall?.args).toContain("--relay-only");
      expect(bootstrapCall?.args).not.toContain("--mesh-endpoint");
      const joinIndex = executor.calls.findIndex((call) =>
        call.command === "devbox"
        && call.args[0] === "exec"
        && call.args.some((arg) => arg.includes("worker join"))
      );
      const startIndex = executor.calls.findIndex((call) =>
        call.command === "devbox"
        && call.args[0] === "exec"
        && call.args.includes("/workspaces/relay-example/.devbox/clanky-worker/launcher.sh")
      );
      expect(joinIndex).toBeGreaterThan(-1);
      expect(startIndex).toBeGreaterThan(joinIndex);
    } finally {
      setMeshRelayTransport(null);
      if (previousPublicBaseUrl === undefined) {
        delete process.env["CLANKY_PUBLIC_BASE_URL"];
      } else {
        process.env["CLANKY_PUBLIC_BASE_URL"] = previousPublicBaseUrl;
      }
    }
  });

  test("keeps the provisioning host separate from the Devbox SSH execution target", async () => {
    const sshServer = await createServer();
    const executor = new ProvisioningTestExecutor({
      devboxStatusOutput: createDevboxStatusOutput({
        workdir: "/workspaces/isolated-example",
        sshPort: 6022,
        sshUser: "workspace-user",
        password: "workspace-secret",
      }),
    });

    sshServerManager.setExecutorFactoryForTesting(() => executor);

    const response = await fetch(`${baseUrl}/api/provisioning-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Isolated Workspace",
        executionHost: { kind: "ssh", serverId: sshServer.config.id },
        transport: "ssh",
        repoUrl: "https://github.com/octocat/isolated.git",
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
    const completed = await waitForJobStatus(baseUrl, started.job.config.id, ["completed"]);
    expect(completed.workspace).toMatchObject({
      directory: "/workspaces/isolated-example",
      executionHostBinding: {
        host: {
          kind: "ssh",
          scope: "workspace",
        },
      },
      provisioningHostBinding: {
        host: {
          kind: "ssh",
          serverId: sshServer.config.id,
        },
      },
      sshTarget: {
        kind: "ssh",
        host: "ssh.example.com",
        port: 6022,
        username: "workspace-user",
        credentialConfigured: true,
      },
    });
    expect(completed.workspace?.executionHostBinding?.host).toMatchObject({
      workspaceId: completed.workspace!.id,
    });
    expect(completed.workspace?.sshTarget?.password).toBeUndefined();

    const { getWorkspaceSshTarget } = await import(
      "../../src/persistence/workspace-execution-targets"
    );
    const storedTarget = await getWorkspaceSshTarget(completed.workspace!.id);
    expect(storedTarget?.password).toBe("workspace-secret");
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
        transport: "ssh",
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
        transport: "ssh",
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
      directory: "/devbox/workspaces/mesh-example",
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

  test("provisions through a workspace-dedicated mesh execution node", async () => {
    const workspaceWorkerEnrollmentId = await seedDedicatedMeshExecutionTarget();
    const executor = new ProvisioningTestExecutor({
      devboxStatusOutput: createDevboxStatusOutput({
        workdir: "/devbox/workspaces/dedicated-example",
      }),
    });
    backendManager.setExecutorFactoryForTesting(() => executor);

    const response = await fetch(`${baseUrl}/api/provisioning-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Dedicated Mesh Example",
        workspaceWorkerEnrollmentId,
        transport: "ssh",
        repoUrl: "https://github.com/octocat/dedicated-example.git",
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
    const completed = await waitForJobStatus(baseUrl, started.job.config.id, ["completed"]);
    expect(completed.workspace).toMatchObject({
      directory: "/devbox/workspaces/dedicated-example",
      executionHostBinding: {
        host: {
          kind: "mesh",
          scope: "workspace",
          nodeId: expect.any(String),
        },
      },
      provisioningHostBinding: {
        host: {
          kind: "mesh",
          scope: "workspace",
          nodeId: expect.any(String),
        },
      },
    });

    expect(completed.workspace?.id).toBeTruthy();
    const deleted = await fetch(
      `${baseUrl}/api/workspaces/${completed.workspace?.id}`,
      { method: "DELETE", body: JSON.stringify({}) },
    );
    expect(deleted.status).toBe(200);
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
        transport: "ssh",
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
        transport: "ssh",
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
        transport: "ssh",
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

    const repeatedCancelResponse = await fetch(
      `${baseUrl}/api/provisioning-jobs/${started.job.config.id}`,
      { method: "DELETE" },
    );
    expect(repeatedCancelResponse.ok).toBe(true);
    expect(
      (await repeatedCancelResponse.json() as { job: { state: { status: string } } }).job.state.status,
    ).toBe("cancelled");
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
        transport: "ssh",
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
  });

  test("keeps a failed job for retry and removes it with its logs on dismiss", async () => {
    const sshServer = await createServer();
    sshServerManager.setExecutorFactoryForTesting(() => new ProvisioningTestExecutor({
      failDevboxVersion: true,
    }));

    const requestBody = {
      name: "Retry Workspace",
      executionHost: { kind: "ssh", serverId: sshServer.config.id },
      transport: "ssh",
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
        transport: "ssh",
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
