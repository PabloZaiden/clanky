import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollUntil } from "../helpers/polling";

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a worker test port"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

test("Mesh worker exposes only its transport and authenticated control surface", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "clanky-mesh-worker-"));
  const port = await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLANKY_DATA_DIR: dataDir,
    CLANKY_HOST: "127.0.0.1",
    CLANKY_LOG_LEVEL: "fatal",
    CLANKY_PORT: String(port),
    CLANKY_PUBLIC_BASE_URL: baseUrl,
  };
  delete env["CLANKY_DISABLE_PASSKEY"];
  delete env["CLANKY_MESH_WORKER"];

  const bootstrap = Bun.spawnSync(
    [process.execPath, "src/index.ts", "worker", "bootstrap"],
    { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" },
  );
  expect(bootstrap.exitCode).toBe(0);
  const bootstrapOutput = bootstrap.stdout.toString().trim().split("\n").at(-1);
  if (!bootstrapOutput) {
    throw new Error(`Worker bootstrap returned no credentials: ${bootstrap.stderr.toString()}`);
  }
  const credentials = JSON.parse(bootstrapOutput) as {
    apiKey: string;
    meshWorker: boolean;
  };
  expect(credentials.meshWorker).toBe(true);
  expect(credentials.apiKey).toBeTruthy();

  const worker = Bun.spawn([
    process.execPath,
    "src/index.ts",
    "serve",
    "--mesh-worker",
    "true",
  ], {
    cwd: process.cwd(),
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });

  try {
    await pollUntil(
      async () => {
        try {
          return (await fetch(`${baseUrl}/api/health`)).ok;
        } catch {
          return false;
        }
      },
      (ready) => ready,
      {
        description: "Mesh worker to become healthy",
        timeoutMs: 10_000,
      },
    );

    const authenticatedHeaders = {
      authorization: `Bearer ${credentials.apiKey}`,
      "content-type": "application/json",
      origin: baseUrl,
    };
    expect((await fetch(`${baseUrl}/api/mesh/status`, {
      headers: authenticatedHeaders,
    })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/mesh/pairing-requests`, {
      method: "POST",
      headers: authenticatedHeaders,
      body: "{}",
    })).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/mesh/internal/health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })).status).toBe(400);

    const blockedRequests: Array<[string, RequestInit?]> = [
      ["/"],
      ["/setup"],
      ["/device"],
      ["/favicon.svg"],
      ["/api/config"],
      ["/api/tasks"],
      ["/api/ws"],
      ["/api/mesh/enrollment-tokens", {
        method: "POST",
        headers: authenticatedHeaders,
        body: "{}",
      }],
      ["/api/mesh/pairing-requests", { headers: authenticatedHeaders }],
      ["/api/mesh/status", {
        method: "POST",
        headers: authenticatedHeaders,
        body: "{}",
      }],
    ];
    for (const [path, init] of blockedRequests) {
      expect((await fetch(`${baseUrl}${path}`, init)).status).toBe(404);
    }
  } finally {
    worker.kill();
    await worker.exited;
    await rm(dataDir, { recursive: true, force: true });
  }
}, 20_000);
