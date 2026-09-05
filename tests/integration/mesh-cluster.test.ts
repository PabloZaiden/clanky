import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollUntil } from "../helpers/polling";

interface MeshProcess {
  baseUrl: string;
  dataDir: string;
  child: ReturnType<typeof Bun.spawn>;
  apiKey?: string;
}

let processes: MeshProcess[] = [];

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate a port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startNode(role: "controller" | "worker"): Promise<MeshProcess> {
  const dataDir = await mkdtemp(join(tmpdir(), `clanky-mesh-${role}-`));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLANKY_DATA_DIR: dataDir,
    CLANKY_HOST: "127.0.0.1",
    CLANKY_PORT: String(port),
    CLANKY_PUBLIC_BASE_URL: baseUrl,
    CLANKY_LOG_LEVEL: "fatal",
  };
  let apiKey: string | undefined;
  if (role === "controller") {
    env["CLANKY_DISABLE_PASSKEY"] = "true";
  } else {
    delete env["CLANKY_DISABLE_PASSKEY"];
    const bootstrap = Bun.spawnSync(
      [process.execPath, "src/index.ts", "worker", "bootstrap"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" },
    );
    if (bootstrap.exitCode !== 0) {
      throw new Error(bootstrap.stderr.toString());
    }
    apiKey = (JSON.parse(bootstrap.stdout.toString().trim().split("\n").at(-1)!) as {
      apiKey: string;
    }).apiKey;
  }

  const child = Bun.spawn([
    process.execPath,
    "src/index.ts",
    "serve",
    ...(role === "worker" ? ["--mesh-worker", "true", "--worker-directory", dataDir] : []),
  ], {
    cwd: process.cwd(),
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const node = { baseUrl, dataDir, child, apiKey };
  processes.push(node);
  await pollUntil(
    async () => fetch(`${baseUrl}/api/health`).then((response) => response.ok).catch(() => false),
    (ready) => ready,
    { description: `${role} to become healthy`, timeoutMs: 10_000 },
  );
  return node;
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
    async () => fetch(`${node.baseUrl}/api/health`).then(
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
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const response = await fetch(`${node.baseUrl}${path}`, {
    method,
    headers: {
      ...(node.apiKey ? { authorization: `Bearer ${node.apiKey}` } : {}),
      ...(method === "GET" ? {} : { origin: node.baseUrl }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() };
}

async function enroll(controller: MeshProcess, worker: MeshProcess): Promise<void> {
  const created = await jsonRequest(controller, "/api/mesh/enrollment-tokens", {
    method: "POST",
    body: { name: "integration", ttlSeconds: 900 },
  });
  expect(created.status).toBe(201);
  const enrollment = created.body as {
    token: string;
    enrollment: { controllerFingerprint: string };
  };
  const result = await jsonRequest(worker, "/api/mesh/enroll", {
    method: "POST",
    body: {
      controllerEndpoint: controller.baseUrl,
      enrollmentToken: enrollment.token,
      expectedControllerFingerprint: enrollment.enrollment.controllerFingerprint,
    },
  });
  expect(result.status).toBe(200);
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
    expect(workerStatus.body).toMatchObject({
      controllerCount: 2,
      execution: { directory: worker.dataDir, acceptRemoteExecution: true },
    });
    expect(workerStatus.body.controllers).toBeUndefined();

    const workerNodeId = statusA.body.workers[0].workerNodeId as string;
    const initialRevision = statusA.body.workers[0].workerConfigRevision as number;
    const nextDirectory = join(worker.dataDir, "next-directory");
    await restartWorker(worker, {
      directory: nextDirectory,
      executionEnabled: false,
    });
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

  test("keeps a registration active until the worker acknowledges revocation", async () => {
    const [controller, worker] = await Promise.all([
      startNode("controller"),
      startNode("worker"),
    ]);
    await enroll(controller, worker);
    const initialStatus = await jsonRequest(controller, "/api/mesh/status");
    const workerNodeId = initialStatus.body.workers[0].workerNodeId as string;

    worker.child.kill();
    await worker.child.exited;
    const unavailableRevocation = await jsonRequest(
      controller,
      "/api/mesh/workers/revoke",
      {
        method: "POST",
        body: { workerNodeId },
      },
    );
    expect(unavailableRevocation.status).toBe(503);
    expect((await jsonRequest(controller, "/api/mesh/status"))
      .body.workers[0].grantStatus).toBe("active");

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
});
