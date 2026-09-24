import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  availablePort,
  enrollMeshWorker,
  meshJsonRequest,
  restartMeshNode,
  sourceClankyCommand,
  startMeshNode,
  type ManagedMeshNode,
} from "../helpers/mesh-process-cluster";
import { pollUntil } from "../helpers/polling";
import { createExecutionHostRuntimeSnapshot } from "../../src/shared/execution-host";

interface MeshProcess {
  baseUrl: string;
  dataDir: string;
  child: ReturnType<typeof Bun.spawn>;
  apiKey?: string;
  tlsCertificate?: string;
}

let processes: MeshProcess[] = [];

async function startNode(
  role: "controller" | "worker",
): Promise<ManagedMeshNode> {
  const node = await startMeshNode({
    role,
    command: sourceClankyCommand(),
  });
  processes.push(node);
  return node;
}

async function startRelay(
  controllerFingerprint: string,
): Promise<MeshProcess> {
  const dataDir = await mkdtemp(join(tmpdir(), "clanky-mesh-relay-"));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const child = Bun.spawn([
    process.execPath,
    "src/index.ts",
    "relay",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLANKY_DATA_DIR: dataDir,
      CLANKY_HOST: "127.0.0.1",
      CLANKY_PORT: String(port),
      CLANKY_RELAY_CONTROLLER_FINGERPRINT: controllerFingerprint,
      CLANKY_LOG_LEVEL: "fatal",
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const relay = { baseUrl, dataDir, child };
  processes.push(relay);
  await pollUntil(
    async () => fetch(`${baseUrl}/.well-known/clanky-mesh`)
      .then((response) => response.ok)
      .catch(() => false),
    (ready) => ready,
    { description: "Mesh relay to become healthy", timeoutMs: 10_000 },
  );
  return relay;
}

async function restartRelay(
  relay: MeshProcess,
  controllerFingerprint: string,
): Promise<void> {
  relay.child.kill();
  await relay.child.exited;
  const port = new URL(relay.baseUrl).port;
  relay.child = Bun.spawn([
    process.execPath,
    "src/index.ts",
    "relay",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLANKY_DATA_DIR: relay.dataDir,
      CLANKY_HOST: "127.0.0.1",
      CLANKY_PORT: port,
      CLANKY_RELAY_CONTROLLER_FINGERPRINT: controllerFingerprint,
      CLANKY_LOG_LEVEL: "fatal",
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await pollUntil(
    async () => fetch(`${relay.baseUrl}/.well-known/clanky-mesh`)
      .then((response) => response.ok)
      .catch(() => false),
    (ready) => ready,
    { description: "restarted Mesh relay to become healthy", timeoutMs: 10_000 },
  );
}

async function startRelayOnlyWorker(input: {
  relayUrl: string;
  token: string;
  controllerFingerprint: string;
}): Promise<MeshProcess> {
  const dataDir = await mkdtemp(join(tmpdir(), "clanky-mesh-relay-worker-"));
  const environment = {
    ...process.env,
    CLANKY_DATA_DIR: dataDir,
    CLANKY_LOG_LEVEL: "fatal",
    CLANKY_DISABLE_PASSKEY: undefined,
    CLANKY_PUBLIC_BASE_URL: undefined,
  };
  const bootstrap = Bun.spawnSync([
    process.execPath,
    "src/index.ts",
    "worker",
    "bootstrap",
    "--relay-only",
    "--worker-directory",
    dataDir,
    "--instance-name",
    "relay-worker",
  ], {
    cwd: process.cwd(),
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (bootstrap.exitCode !== 0) {
    throw new Error(bootstrap.stderr.toString());
  }
  const joinResult = Bun.spawnSync([
    process.execPath,
    "src/index.ts",
    "worker",
    "join",
    input.relayUrl,
    "--token",
    input.token,
    "--fingerprint",
    input.controllerFingerprint,
  ], {
    cwd: process.cwd(),
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (joinResult.exitCode !== 0) {
    throw new Error(joinResult.stderr.toString());
  }
  const child = Bun.spawn([
    process.execPath,
    "src/index.ts",
    "serve",
  ], {
    cwd: process.cwd(),
    env: environment,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const worker = { baseUrl: "", dataDir, child };
  processes.push(worker);
  return worker;
}

function joinRelayWorker(input: {
  worker: MeshProcess;
  relayUrl: string;
  token: string;
  controllerFingerprint: string;
}): void {
  const result = Bun.spawnSync([
    process.execPath,
    "src/index.ts",
    "worker",
    "join",
    input.relayUrl,
    "--token",
    input.token,
    "--fingerprint",
    input.controllerFingerprint,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLANKY_DATA_DIR: input.worker.dataDir,
      CLANKY_LOG_LEVEL: "fatal",
      CLANKY_DISABLE_PASSKEY: undefined,
      CLANKY_PUBLIC_BASE_URL: undefined,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
}

function restartRelayOnlyWorker(worker: MeshProcess): void {
  worker.child = Bun.spawn([
    process.execPath,
    "src/index.ts",
    "serve",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLANKY_DATA_DIR: worker.dataDir,
      CLANKY_LOG_LEVEL: "fatal",
      CLANKY_DISABLE_PASSKEY: undefined,
      CLANKY_PUBLIC_BASE_URL: undefined,
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function restartWorker(
  node: MeshProcess,
  options: { directory: string; executionEnabled: boolean },
): Promise<void> {
  node.child.kill();
  await node.child.exited;
  await mkdir(options.directory, { recursive: true });
  const port = new URL(node.baseUrl).port;
  node.child = Bun.spawn([
    process.execPath,
    "src/index.ts",
    "serve",
    "--mesh-worker",
    "true",
    "--worker-directory",
    options.directory,
    "--worker-execution-enabled",
    String(options.executionEnabled),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLANKY_DATA_DIR: node.dataDir,
      CLANKY_HOST: "127.0.0.1",
      CLANKY_PORT: port,
      CLANKY_PUBLIC_BASE_URL: node.baseUrl,
      CLANKY_LOG_LEVEL: "fatal",
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await pollUntil(
    async () => fetch(`${node.baseUrl}/api/health`, {
      tls: node.tlsCertificate ? { ca: node.tlsCertificate } : undefined,
    }).then(
      (response) => response.ok,
    ).catch(() => false),
    (ready) => ready,
    { description: "worker restart to become healthy", timeoutMs: 10_000 },
  );
}

async function jsonRequest(
  node: MeshProcess,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  return await meshJsonRequest<any>(node, path, options);
}

async function executeRelayWorkerWhenReady(
  controller: MeshProcess,
  workerNodeId: string,
  directory: string,
  description: string,
): Promise<{ status: number; body: { success: boolean; stdout: string } }> {
  return await pollUntil(
    async () => await meshJsonRequest<{ success: boolean; stdout: string }>(
      controller,
      `/api/execution-hosts/mesh/${encodeURIComponent(workerNodeId)}/exec`,
      {
        method: "POST",
        body: {
          command: "pwd",
          args: [],
          cwd: directory,
          timeoutMs: 5_000,
        },
      },
    ),
    (result) => result.status === 200,
    {
      description,
      timeoutMs: 15_000,
      formatLastObserved: (result) => JSON.stringify(result),
    },
  );
}

async function enroll(
  controller: ManagedMeshNode,
  worker: ManagedMeshNode,
): Promise<void> {
  const enrollment = await enrollMeshWorker(controller, worker);
  expect(enrollment.workerJoinCommand).toBe(
    `clanky worker join '${controller.baseUrl}' --token '${enrollment.token}' --fingerprint '${enrollment.enrollment.controllerFingerprint}'`,
  );
}

afterEach(async () => {
  for (const process of processes) {
    process.child.kill();
    await process.child.exited;
    await rm(process.dataDir, { recursive: true, force: true });
  }
  processes = [];
});

describe("controller-worker Mesh", () => {
  test("enrolls multiple relay-only workers and reconnects after restarts", async () => {
    const controller = await startNode("controller");
    const controllerStatus = await jsonRequest(controller, "/api/mesh/status");
    const unavailableRelayInvitation = await jsonRequest(
      controller,
      "/api/mesh/enrollment-tokens",
      {
        method: "POST",
        body: { name: "relay unavailable", ttlSeconds: 900, route: "relay" },
      },
    );
    expect(unavailableRelayInvitation).toMatchObject({
      status: 409,
      body: { error: "mesh_relay_not_paired" },
    });
    const relay = await startRelay(controllerStatus.body.node.fingerprint as string);
    const paired = await jsonRequest(controller, "/api/mesh/relay", {
      method: "POST",
      body: { name: "east", relayUrl: relay.baseUrl },
    });
    expect(paired).toMatchObject({
      status: 201,
      body: {
        primaryName: "east",
        relays: [{ name: "east", relayUrl: relay.baseUrl, connected: true }],
      },
    });

    const created = await jsonRequest(
      controller,
      "/api/mesh/enrollment-tokens",
      {
        method: "POST",
        body: { name: "relay integration", ttlSeconds: 900, route: "relay" },
      },
    );
    expect(created.status).toBe(201);
    expect(created.body.workerJoinCommand).toBe(
      `clanky worker join '${relay.baseUrl}' --token '${created.body.token}' --fingerprint '${created.body.enrollment.controllerFingerprint}'`,
    );
    const worker = await startRelayOnlyWorker({
      relayUrl: relay.baseUrl,
      token: created.body.token as string,
      controllerFingerprint:
        created.body.enrollment.controllerFingerprint as string,
    });
    const secondEnrollment = await jsonRequest(
      controller,
      "/api/mesh/enrollment-tokens",
      {
        method: "POST",
        body: { name: "second relay worker", ttlSeconds: 900, route: "relay" },
      },
    );
    expect(secondEnrollment.status).toBe(201);
    const secondWorker = await startRelayOnlyWorker({
      relayUrl: relay.baseUrl,
      token: secondEnrollment.body.token as string,
      controllerFingerprint:
        secondEnrollment.body.enrollment.controllerFingerprint as string,
    });

    const status = await pollUntil(
      async () => (await jsonRequest(controller, "/api/mesh/status")).body,
      (body) => body.workers?.length === 2
        && body.workers.every((entry: any) => entry.route?.kind === "relay"),
      {
        description: "relay worker registration",
        timeoutMs: 10_000,
        formatLastObserved: (body) => JSON.stringify(body),
      },
    );
    const workers = status.workers as Array<{
      workerNodeId: string;
      workerEndpoint: string;
      route: { kind: string; targetNodeId: string; relayUrl: string };
    }>;
    for (const registration of workers) {
      expect(registration).toMatchObject({
        workerEndpoint: relay.baseUrl,
        route: {
          kind: "relay",
          targetNodeId: registration.workerNodeId,
          relayUrl: relay.baseUrl,
        },
      });
    }

    const [firstRegistration, secondRegistration] = workers;
    const initialExecutions = await Promise.all([
      executeRelayWorkerWhenReady(
        controller,
        firstRegistration!.workerNodeId,
        worker.dataDir,
        "first relay worker command execution",
      ),
      executeRelayWorkerWhenReady(
        controller,
        secondRegistration!.workerNodeId,
        secondWorker.dataDir,
        "second relay worker command execution",
      ),
    ]);
    expect(initialExecutions.map((result) => result.body.stdout).sort()).toEqual([
      `${secondWorker.dataDir}\n`,
      `${worker.dataDir}\n`,
    ].sort());

    const replacementEnrollment = await jsonRequest(
      controller,
      "/api/mesh/enrollment-tokens",
      {
        method: "POST",
        body: { name: "replacement relay enrollment", ttlSeconds: 900, route: "relay" },
      },
    );
    expect(replacementEnrollment.status).toBe(201);
    joinRelayWorker({
      worker,
      relayUrl: relay.baseUrl,
      token: replacementEnrollment.body.token as string,
      controllerFingerprint:
        replacementEnrollment.body.enrollment.controllerFingerprint as string,
    });

    worker.child.kill();
    await worker.child.exited;
    restartRelayOnlyWorker(worker);
    const restartedExecution = await executeRelayWorkerWhenReady(
      controller,
      firstRegistration!.workerNodeId,
      worker.dataDir,
      "persisted relay worker route after restart",
    );
    expect(restartedExecution.body).toMatchObject({
      success: true,
      stdout: `${worker.dataDir}\n`,
    });

    await restartRelay(
      relay,
      controllerStatus.body.node.fingerprint as string,
    );
    const afterRelayRestart = await Promise.all([
      executeRelayWorkerWhenReady(
        controller,
        firstRegistration!.workerNodeId,
        worker.dataDir,
        "first worker after relay restart",
      ),
      executeRelayWorkerWhenReady(
        controller,
        secondRegistration!.workerNodeId,
        secondWorker.dataDir,
        "second worker after relay restart",
      ),
    ]);
    expect(afterRelayRestart.every((result) => result.body.success === true)).toBe(true);
  }, 60_000);

  test("keeps workers on independently connected relays when the primary changes", async () => {
    const controller = await startNode("controller");
    const controllerStatus = await jsonRequest(controller, "/api/mesh/status");
    const fingerprint = controllerStatus.body.node.fingerprint as string;
    const [east, west] = await Promise.all([
      startRelay(fingerprint),
      startRelay(fingerprint),
    ]);
    for (const [name, relay] of [["east", east], ["west", west]] as const) {
      const paired = await jsonRequest(controller, "/api/mesh/relay", {
        method: "POST",
        body: { name, relayUrl: relay.baseUrl },
      });
      expect(paired.status).toBe(201);
    }
    const apiKey = await jsonRequest(controller, "/api/api-keys", {
      method: "POST",
      body: { name: "Mesh CLI integration", scopes: ["*"] },
    });
    expect(apiKey.status).toBe(200);
    const runCli = (...args: string[]) => Bun.spawnSync([
      ...sourceClankyCommand(),
      "mesh",
      ...args,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLANKY_DATA_DIR: controller.dataDir,
        CLANKY_BASE_URL: controller.baseUrl,
        CLANKY_API_KEY: apiKey.body.token as string,
        CLANKY_LOG_LEVEL: "fatal",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const invite = async (relayName?: string) => await jsonRequest(
      controller,
      "/api/mesh/enrollment-tokens",
      {
        method: "POST",
        body: {
          name: "Relay worker",
          route: "relay",
          ...(relayName ? { relayName } : {}),
        },
      },
    );
    const eastInvite = await invite();
    expect(eastInvite.status).toBe(201);
    expect(eastInvite.body.workerJoinCommand).toContain(`'${east.baseUrl}'`);
    const eastWorker = await startRelayOnlyWorker({
      relayUrl: east.baseUrl,
      token: eastInvite.body.token as string,
      controllerFingerprint: fingerprint,
    });
    const westInvite = await invite("west");
    expect(westInvite.status).toBe(201);
    expect(westInvite.body.workerJoinCommand).toContain(`'${west.baseUrl}'`);
    const westWorker = await startRelayOnlyWorker({
      relayUrl: west.baseUrl,
      token: westInvite.body.token as string,
      controllerFingerprint: fingerprint,
    });

    const status = await pollUntil(
      async () => (await jsonRequest(controller, "/api/mesh/status")).body,
      (body) => body.workers?.length === 2
        && body.workers.some((worker: { route: { relayUrl: string } }) =>
          worker.route.relayUrl === east.baseUrl)
        && body.workers.some((worker: { route: { relayUrl: string } }) =>
          worker.route.relayUrl === west.baseUrl),
      {
        description: "workers to enroll on separate relays",
        timeoutMs: 15_000,
        formatLastObserved: (body) => JSON.stringify(body),
      },
    );
    const registrations = status.workers as Array<{
      workerNodeId: string;
      route: { kind: string; relayUrl: string };
    }>;
    const eastNodeId = registrations.find((worker) =>
      worker.route.relayUrl === east.baseUrl)!.workerNodeId;
    const westNodeId = registrations.find((worker) =>
      worker.route.relayUrl === west.baseUrl)!.workerNodeId;
    const initial = await Promise.all([
      executeRelayWorkerWhenReady(
        controller, eastNodeId, eastWorker.dataDir, "east relay worker to execute",
      ),
      executeRelayWorkerWhenReady(
        controller, westNodeId, westWorker.dataDir, "west relay worker to execute",
      ),
    ]);
    expect(initial.map((result) => result.body.stdout).sort()).toEqual([
      `${eastWorker.dataDir}\n`, `${westWorker.dataDir}\n`,
    ].sort());

    const boundInvite = await invite("east");
    expect(boundInvite.status).toBe(201);
    expect(() => joinRelayWorker({
      worker: eastWorker,
      relayUrl: west.baseUrl,
      token: boundInvite.body.token as string,
      controllerFingerprint: fingerprint,
    })).toThrow();
    joinRelayWorker({
      worker: eastWorker,
      relayUrl: east.baseUrl,
      token: boundInvite.body.token as string,
      controllerFingerprint: fingerprint,
    });

    const changed = await jsonRequest(controller, "/api/mesh/relay/primary", {
      method: "POST",
      body: { name: "west" },
    });
    expect(changed.status).toBe(200);
    expect(changed.body.primaryName).toBe("west");
    expect(changed.body.relays).toContainEqual(
      expect.objectContaining({ name: "west", isPrimary: true }),
    );
    expect(changed.body.relays).toContainEqual(
      expect.objectContaining({ name: "east", isPrimary: false }),
    );
    expect((await invite()).body.workerJoinCommand).toContain(`'${west.baseUrl}'`);
    const namedCliInvite = runCli(
      "enrollment-token", "create", "--route", "relay", "--relay", "east",
    );
    if (namedCliInvite.exitCode !== 0) {
      throw new Error(
        `Mesh CLI invitation failed: ${namedCliInvite.stderr.toString()}`,
      );
    }
    expect(JSON.parse(namedCliInvite.stdout.toString()).response.workerJoinCommand)
      .toContain(`'${east.baseUrl}'`);
    const unchanged = await Promise.all([
      executeRelayWorkerWhenReady(
        controller, eastNodeId, eastWorker.dataDir, "east worker after changing primary",
      ),
      executeRelayWorkerWhenReady(
        controller, westNodeId, westWorker.dataDir, "west worker after changing primary",
      ),
    ]);
    expect(unchanged.every((result) => result.body.success)).toBe(true);

    const cliUnpair = runCli("relay", "unpair", "--name", "west");
    expect(cliUnpair.exitCode).toBe(0);
    const removed = await jsonRequest(controller, "/api/mesh/relay");
    expect(removed).toMatchObject({
      status: 200,
      body: { primaryName: null, relays: [{ name: "east", connected: true }] },
    });
    expect((await invite()).status).toBe(409);
    expect((await invite("east")).status).toBe(201);
    expect((await executeRelayWorkerWhenReady(
      controller, eastNodeId, eastWorker.dataDir, "east worker after west unpair",
    )).body.success).toBe(true);
    const disconnected = await jsonRequest(
      controller,
      `/api/execution-hosts/mesh/${encodeURIComponent(westNodeId)}/exec`,
      {
        method: "POST",
        body: { command: "pwd", args: [], cwd: westWorker.dataDir, timeoutMs: 5_000 },
      },
    );
    expect(disconnected.status).toBeGreaterThanOrEqual(400);
    const unchangedRegistration = await jsonRequest(controller, "/api/mesh/status");
    expect(unchangedRegistration.body.workers).toContainEqual(
      expect.objectContaining({
        workerNodeId: westNodeId,
        route: expect.objectContaining({ relayUrl: west.baseUrl }),
      }),
    );

    expect((await jsonRequest(controller, "/api/mesh/relay", {
      method: "POST",
      body: { name: "west", relayUrl: west.baseUrl },
    })).status).toBe(201);
    expect((await executeRelayWorkerWhenReady(
      controller, westNodeId, westWorker.dataDir, "west worker after re-pair",
    )).body.success).toBe(true);
  }, 90_000);

  test("refreshes worker health when the controller starts", async () => {
    const [controller, worker] = await Promise.all([
      startNode("controller"),
      startNode("worker"),
    ]);
    await enroll(controller, worker);

    const nextDirectory = join(worker.dataDir, "startup-refresh");
    await mkdir(nextDirectory, { recursive: true });
    worker.serveArguments = [
      "serve",
      "--mesh-worker",
      "true",
      "--worker-directory",
      nextDirectory,
      "--worker-execution-enabled",
      "false",
    ];
    await restartMeshNode(worker);
    await restartMeshNode(controller);

    const status = await pollUntil(
      async () => (await jsonRequest(controller, "/api/mesh/status")).body,
      (body) => body.workers?.[0]?.workerDirectory === nextDirectory
        && body.workers?.[0]?.workerAcceptRemoteExecution === false,
      {
        description: "startup health refresh to update the worker snapshot",
        timeoutMs: 15_000,
        formatLastObserved: (body) => JSON.stringify(body),
      },
    );
    expect(status.workers[0]).toMatchObject({
      workerDirectory: nextDirectory,
      workerAcceptRemoteExecution: false,
    });
  }, 45_000);

  test("refreshes worker health after controller relay re-authentication", async () => {
    const [controller, worker] = await Promise.all([
      startNode("controller"),
      startNode("worker"),
    ]);
    await enroll(controller, worker);
    const controllerStatus = await jsonRequest(controller, "/api/mesh/status");
    const relay = await startRelay(controllerStatus.body.node.fingerprint as string);
    const paired = await jsonRequest(controller, "/api/mesh/relay", {
      method: "POST",
      body: { name: "east", relayUrl: relay.baseUrl },
    });
    expect(paired.status).toBe(201);

    const nextDirectory = join(worker.dataDir, "relay-refresh");
    await mkdir(nextDirectory, { recursive: true });
    worker.serveArguments = [
      "serve",
      "--mesh-worker",
      "true",
      "--worker-directory",
      nextDirectory,
      "--worker-execution-enabled",
      "false",
    ];
    await restartMeshNode(worker);
    await restartRelay(
      relay,
      controllerStatus.body.node.fingerprint as string,
    );

    const status = await pollUntil(
      async () => (await jsonRequest(controller, "/api/mesh/status")).body,
      (body) => body.workers?.[0]?.workerDirectory === nextDirectory
        && body.workers?.[0]?.workerAcceptRemoteExecution === false,
      {
        description: "relay authentication health refresh to update the worker snapshot",
        timeoutMs: 30_000,
        formatLastObserved: (body) => JSON.stringify(body),
      },
    );
    expect(status.workers[0]).toMatchObject({
      workerDirectory: nextDirectory,
      workerAcceptRemoteExecution: false,
    });
  }, 60_000);

  test("one worker accepts isolated grants from two controllers", async () => {
    const [controllerA, controllerB, worker] = await Promise.all([
      startNode("controller"),
      startNode("controller"),
      startNode("worker"),
    ]);
    await enroll(controllerA, worker);
    await enroll(controllerB, worker);

    const [statusA, statusB, workerStatus] = await Promise.all([
      jsonRequest(controllerA, "/api/mesh/status"),
      jsonRequest(controllerB, "/api/mesh/status"),
      jsonRequest(worker, "/api/mesh/status"),
    ]);
    expect(statusA.body.workers).toHaveLength(1);
    expect(statusB.body.workers).toHaveLength(1);
    expect(statusA.body.workers[0].workerInstanceName).toBe("worker-1");
    expect(workerStatus.body).toMatchObject({
      controllerCount: 2,
      execution: { directory: worker.dataDir, acceptRemoteExecution: true },
    });
    expect(workerStatus.body.controllers).toBeUndefined();

    const workerNodeId = statusA.body.workers[0].workerNodeId as string;
    const originalTlsCertificate = worker.tlsCertificate;
    const initialRevision = statusA.body.workers[0].workerConfigRevision as number;
    const nextDirectory = join(worker.dataDir, "next-directory");
    await restartWorker(worker, {
      directory: nextDirectory,
      executionEnabled: false,
    });
    expect(worker.tlsCertificate).toBe(originalTlsCertificate);
    expect((await jsonRequest(controllerA, "/api/mesh/health", {
      method: "POST",
    })).status).toBe(200);
    expect((await jsonRequest(controllerB, "/api/mesh/health", {
      method: "POST",
    })).status).toBe(200);
    const [updatedStatusA, updatedStatusB] = await Promise.all([
      jsonRequest(controllerA, "/api/mesh/status"),
      jsonRequest(controllerB, "/api/mesh/status"),
    ]);
    for (const status of [updatedStatusA, updatedStatusB]) {
      expect(status.body.workers[0]).toMatchObject({
        workerDirectory: nextDirectory,
        workerAcceptRemoteExecution: false,
      });
      expect(status.body.workers[0].workerConfigRevision)
        .toBeGreaterThan(initialRevision);
    }

    expect(await jsonRequest(controllerA, "/api/mesh/workers/revoke", {
      method: "POST",
      body: { workerNodeId },
    })).toMatchObject({ status: 200 });
    expect((await jsonRequest(controllerB, "/api/mesh/status")).body.workers[0].grantStatus).toBe("active");
  }, 30_000);

  test("revokes the controller registration when the worker is offline", async () => {
    const [controller, worker] = await Promise.all([
      startNode("controller"),
      startNode("worker"),
    ]);
    await enroll(controller, worker);
    const initialStatus = await jsonRequest(controller, "/api/mesh/status");
    const workerNodeId = initialStatus.body.workers[0].workerNodeId as string;

    worker.child.kill();
    await worker.child.exited;
    const offlineRevocation = await jsonRequest(
      controller,
      "/api/mesh/workers/revoke",
      {
        method: "POST",
        body: { workerNodeId },
      },
    );
    expect(offlineRevocation.status).toBe(200);
    expect((await jsonRequest(controller, "/api/mesh/status"))
      .body.workers[0].grantStatus).toBe("revoked");

    await restartWorker(worker, {
      directory: worker.dataDir,
      executionEnabled: true,
    });
    expect(await jsonRequest(controller, "/api/mesh/workers/revoke", {
      method: "POST",
      body: { workerNodeId },
    })).toMatchObject({ status: 200 });
    expect((await jsonRequest(controller, "/api/mesh/status"))
      .body.workers[0].grantStatus).toBe("revoked");
    expect((await jsonRequest(worker, "/api/mesh/status"))
      .body.controllerCount).toBe(0);
  }, 30_000);

  test("controller can terminate an enrolled worker through the signed Mesh command", async () => {
    const [controller, worker] = await Promise.all([
      startNode("controller"),
      startNode("worker"),
    ]);
    await enroll(controller, worker);
    const status = await jsonRequest(controller, "/api/mesh/status");
    const workerNodeId = status.body.workers[0].workerNodeId as string;

    const kill = await jsonRequest(
      controller,
      `/api/mesh/workers/${encodeURIComponent(workerNodeId)}/kill`,
      { method: "POST" },
    );

    expect(kill.status).toBe(200);
    expect(await worker.child.exited).toBe(1);
  }, 30_000);

  test("controller executes a command on a globally discoverable Mesh host", async () => {
    const [controller, worker] = await Promise.all([
      startNode("controller"),
      startNode("worker"),
    ]);
    await enroll(controller, worker);

    const meshHost = await pollUntil(
      async () => (await jsonRequest(controller, "/api/execution-hosts")).body as Array<{
        ref: { kind: string; nodeId?: string };
        endpoint: string | null;
        meshRouteKind: "direct" | "relay" | null;
        platform: { os: string; architecture: string } | null;
        capabilities: Record<string, number>;
      }>,
      (hosts) => hosts.some(
        (host) => host.ref.kind === "mesh" && host.ref.nodeId !== undefined,
      ),
      { description: "Mesh worker in execution-host catalog", timeoutMs: 10_000 },
    );
    const workerNodeId = meshHost.find(
      (host) => host.ref.kind === "mesh" && host.ref.nodeId !== undefined,
    )!.ref.nodeId!;
    expect(meshHost.find(
      (host) => host.ref.kind === "mesh" && host.ref.nodeId === workerNodeId,
    )).toMatchObject({
      endpoint: worker.baseUrl,
      meshRouteKind: "direct",
      ...createExecutionHostRuntimeSnapshot(process.platform, process.arch),
    });

    const execution = await jsonRequest(
      controller,
      `/api/execution-hosts/mesh/${encodeURIComponent(workerNodeId)}/exec`,
      {
        method: "POST",
        body: {
          command: "pwd",
          args: [],
          cwd: worker.dataDir,
          timeoutMs: 5_000,
        },
      },
    );

    expect(execution.status).toBe(200);
    expect(execution.body).toMatchObject({
      executionHost: `mesh:${workerNodeId}`,
      success: true,
      stdout: `${worker.dataDir}\n`,
      stderr: "",
      exitCode: 0,
    });
  }, 30_000);

  test("keeps a dedicated worker out of global hosts and removes it with its workspace", async () => {
    const [controller, worker] = await Promise.all([
      startNode("controller"),
      startNode("worker"),
    ]);
    const workspaceDirectory = join(worker.dataDir, "workspace");
    await mkdir(workspaceDirectory, { recursive: true });

    const created = await jsonRequest(controller, "/api/workspace-worker-enrollments", {
      method: "POST",
      body: { name: "Dedicated integration worker", ttlSeconds: 900 },
    });
    expect(created.status).toBe(201);
    const enrollmentId = created.body.enrollment.id as string;
    const enrollment = created.body as {
      token: string;
      tokenSummary: { controllerFingerprint: string };
      workerJoinCommand: string;
    };
    expect(enrollment.workerJoinCommand).toContain("clanky worker join");

    const joinResult = Bun.spawnSync([
      process.execPath,
      "src/index.ts",
      "worker",
      "join",
      controller.baseUrl,
      "--token",
      enrollment.token,
      "--fingerprint",
      enrollment.tokenSummary.controllerFingerprint,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLANKY_DATA_DIR: worker.dataDir,
        CLANKY_LOG_LEVEL: "fatal",
        CLANKY_DISABLE_PASSKEY: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (joinResult.exitCode !== 0) {
      const controllerLog = await Bun.file(join(controller.dataDir, "logs/server.log")).text().catch(() => "");
      throw new Error(`${joinResult.stderr.toString()}\n${controllerLog}`);
    }

    await pollUntil(
      async () => {
        const status = await jsonRequest(
          controller,
          `/api/workspace-worker-enrollments/${encodeURIComponent(enrollmentId)}`,
        );
        return status.body.enrollment.status;
      },
      (status) => status === "connected",
      { description: "dedicated worker to connect", timeoutMs: 10_000 },
    );

    const meshStatus = await jsonRequest(controller, "/api/mesh/status");
    const workerNodeId = meshStatus.body.workers[0].workerNodeId as string;
    const globalHosts = await jsonRequest(controller, "/api/execution-hosts");
    expect(globalHosts.body.some(
      (host: { ref: { kind: string; nodeId?: string } }) =>
        host.ref.kind === "mesh" && host.ref.nodeId === workerNodeId,
    )).toBe(false);

    const workspace = await jsonRequest(controller, "/api/workspaces", {
      method: "POST",
      body: {
        name: "Dedicated workspace",
        directory: workspaceDirectory,
        workspaceType: "directory",
        serverSettings: { agent: { provider: "opencode" } },
        workspaceWorkerEnrollmentId: enrollmentId,
      },
    });
    expect(workspace.status).toBe(201);
    expect(workspace.body.executionHostBinding.host).toMatchObject({
      kind: "mesh",
      scope: "workspace",
      workspaceId: workspace.body.id,
      nodeId: workerNodeId,
    });

    const updated = await jsonRequest(
      controller,
      `/api/workspaces/${encodeURIComponent(workspace.body.id)}`,
      {
        method: "PUT",
        body: {
          name: "Dedicated workspace updated",
          directory: workspace.body.directory,
          executionHost: workspace.body.executionHostBinding.host,
        },
      },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe("Dedicated workspace updated");

    const secondWorkspace = await jsonRequest(controller, "/api/workspaces", {
      method: "POST",
      body: {
        name: "Second dedicated workspace",
        directory: workspaceDirectory,
        workspaceType: "directory",
        serverSettings: { agent: { provider: "opencode" } },
        workspaceWorkerEnrollmentId: enrollmentId,
      },
    });
    if (secondWorkspace.status !== 409) {
      throw new Error(JSON.stringify(secondWorkspace.body));
    }

    const deleted = await jsonRequest(
      controller,
      `/api/workspaces/${encodeURIComponent(workspace.body.id)}`,
      { method: "DELETE", body: {} },
    );
    expect(deleted.status).toBe(200);
    const finalEnrollment = await jsonRequest(
      controller,
      `/api/workspace-worker-enrollments/${encodeURIComponent(enrollmentId)}`,
    );
    expect(finalEnrollment.body.enrollment.status).toBe("cancelled");
    expect((await jsonRequest(controller, "/api/mesh/status")).body.workers).toHaveLength(0);
    expect((await jsonRequest(controller, "/api/execution-hosts")).body.some(
      (host: { ref: { kind: string; nodeId?: string } }) =>
        host.ref.kind === "mesh" && host.ref.nodeId === workerNodeId,
    )).toBe(false);
    expect((await jsonRequest(worker, "/api/health")).status).toBe(200);
  }, 30_000);
});
