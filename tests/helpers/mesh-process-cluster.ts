/**
 * Portable process harness for public-boundary Mesh tests.
 */

import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pollUntil } from "./polling";

const rootDirectory = resolve(import.meta.dir, "../..");
const MAX_CAPTURED_PROCESS_OUTPUT = 64 * 1024;

export interface MeshHttpNode {
  baseUrl: string;
  dataDir: string;
  apiKey?: string;
  tlsCertificate?: string;
}

interface CapturedProcessOutput {
  stdout: Promise<string>;
  stderr: Promise<string>;
  snapshot(): string;
}

export interface ManagedMeshNode extends MeshHttpNode {
  role: "controller" | "worker";
  command: string[];
  child: ReturnType<typeof Bun.spawn>;
  generation: number;
  environment: Record<string, string | undefined>;
  serveArguments: string[];
  output: CapturedProcessOutput;
}

export interface MeshJsonResponse<T> {
  status: number;
  body: T;
}

export interface MeshEnrollmentResult {
  token: string;
  enrollment: {
    controllerFingerprint: string;
  };
  workerJoinCommand: string;
}

export async function availablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate a port"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

export function sourceClankyCommand(): string[] {
  return [process.execPath, "src/index.ts"];
}

export async function compiledClankyCommand(): Promise<string[]> {
  const candidates = process.platform === "win32"
    ? [resolve(rootDirectory, "dist", "clanky.exe"), resolve(rootDirectory, "dist", "clanky")]
    : [resolve(rootDirectory, "dist", "clanky"), resolve(rootDirectory, "dist", "clanky.exe")];
  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) {
      return [candidate];
    }
  }
  throw new Error(
    `Compiled Clanky binary not found. Expected one of: ${candidates.join(", ")}. Run bun run build first.`,
  );
}

interface CapturedStream {
  completed: Promise<string>;
  snapshot(): string;
}

function captureStream(stream: ReadableStream<Uint8Array> | number | undefined): CapturedStream {
  let output = "";
  const append = (chunk: string): void => {
    output = `${output}${chunk}`.slice(-MAX_CAPTURED_PROCESS_OUTPUT);
  };
  const completed = stream instanceof ReadableStream
    ? (async (): Promise<string> => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              append(decoder.decode());
              return output;
            }
            append(decoder.decode(value, { stream: true }));
          }
        } finally {
          reader.releaseLock();
        }
      })()
    : Promise.resolve("");
  return {
    completed,
    snapshot: () => output,
  };
}

function capturedOutput(child: ReturnType<typeof Bun.spawn>): CapturedProcessOutput {
  const stdout = captureStream(child.stdout);
  const stderr = captureStream(child.stderr);
  return {
    stdout: stdout.completed,
    stderr: stderr.completed,
    snapshot: () => [stdout.snapshot().trim(), stderr.snapshot().trim()]
      .filter((value) => value.length > 0)
      .join("\n"),
  };
}

function spawnNodeServer(node: Pick<
  ManagedMeshNode,
  "command" | "environment" | "serveArguments"
>): {
  child: ReturnType<typeof Bun.spawn>;
  output: CapturedProcessOutput;
} {
  const child = Bun.spawn([...node.command, ...node.serveArguments], {
    cwd: rootDirectory,
    env: node.environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    child,
    output: capturedOutput(child),
  };
}

async function readProcessOutput(node: ManagedMeshNode): Promise<string> {
  const [stdout, stderr] = await Promise.all([
    node.output.stdout,
    node.output.stderr,
  ]);
  return [stdout.trim(), stderr.trim()]
    .filter((value) => value.length > 0)
    .join("\n");
}

async function stopNodeServer(node: ManagedMeshNode): Promise<string> {
  if (node.child.exitCode === null) {
    node.child.kill();
  }
  await node.child.exited;
  return await readProcessOutput(node);
}

async function waitForNodeHealth(
  node: MeshHttpNode,
  description: string,
  timeoutMs: number,
): Promise<void> {
  await pollUntil(
    async () => await fetch(`${node.baseUrl}/api/health`, {
      tls: node.tlsCertificate ? { ca: node.tlsCertificate } : undefined,
    }).then((response) => response.ok).catch(() => false),
    (ready) => ready,
    { description, timeoutMs },
  );
}

function parseBootstrapApiKey(stdout: string): string {
  const lastLine = stdout.trim().split(/\r?\n/).at(-1);
  if (!lastLine) {
    throw new Error("Worker bootstrap did not return a JSON result");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastLine);
  } catch (error) {
    throw new Error("Worker bootstrap returned invalid JSON", { cause: error });
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || typeof (parsed as Record<string, unknown>)["apiKey"] !== "string"
  ) {
    throw new Error("Worker bootstrap did not return an API key");
  }
  return (parsed as Record<string, string>)["apiKey"]!;
}

async function readWorkerTlsCertificate(dataDir: string): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await Bun.file(join(dataDir, "mesh", "worker-tls.json")).text(),
    );
  } catch (error) {
    throw new Error("Worker bootstrap did not create valid TLS configuration", {
      cause: error,
    });
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || typeof (parsed as Record<string, unknown>)["certificate"] !== "string"
  ) {
    throw new Error("Worker TLS configuration does not contain a certificate");
  }
  return (parsed as Record<string, string>)["certificate"]!;
}

export async function startMeshNode(options: {
  role: "controller" | "worker";
  command: string[];
  instanceName?: string;
  timeoutMs?: number;
  environment?: Record<string, string | undefined>;
}): Promise<ManagedMeshNode> {
  const { role, command } = options;
  const dataDir = await mkdtemp(join(tmpdir(), `clanky-mesh-${role}-`));
  let node: ManagedMeshNode | undefined;

  try {
    const port = await availablePort();
    const baseUrl = `${role === "worker" ? "https" : "http"}://127.0.0.1:${String(port)}`;
    const environment: Record<string, string | undefined> = {
      ...process.env,
      ...options.environment,
      CLANKY_DATA_DIR: dataDir,
      CLANKY_HOST: "127.0.0.1",
      CLANKY_PORT: String(port),
      CLANKY_PUBLIC_BASE_URL: baseUrl,
      CLANKY_LOG_LEVEL: "fatal",
    };
    let apiKey: string | undefined;
    let tlsCertificate: string | undefined;

    if (role === "controller") {
      environment["CLANKY_DISABLE_PASSKEY"] = "true";
    } else {
      delete environment["CLANKY_DISABLE_PASSKEY"];
      const bootstrap = Bun.spawnSync([
        ...command,
        "worker",
        "bootstrap",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--worker-directory",
        dataDir,
        "--mesh-endpoint",
        baseUrl,
        "--instance-name",
        options.instanceName ?? "worker-1",
      ], {
        cwd: rootDirectory,
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (bootstrap.exitCode !== 0) {
        const output = [
          bootstrap.stdout.toString().trim(),
          bootstrap.stderr.toString().trim(),
        ].filter((value) => value.length > 0).join("\n");
        throw new Error(`Worker bootstrap failed: ${output || `exit code ${bootstrap.exitCode}`}`);
      }
      apiKey = parseBootstrapApiKey(bootstrap.stdout.toString());
      tlsCertificate = await readWorkerTlsCertificate(dataDir);
    }

    const serveArguments = [
      "serve",
      ...(role === "worker"
        ? ["--mesh-worker", "true", "--worker-directory", dataDir]
        : []),
    ];
    const started = spawnNodeServer({
      command,
      environment,
      serveArguments,
    });
    node = {
      role,
      command: [...command],
      baseUrl,
      dataDir,
      apiKey,
      tlsCertificate,
      environment,
      serveArguments,
      child: started.child,
      output: started.output,
      generation: 1,
    };

    await waitForNodeHealth(
      node,
      `${role} to become healthy`,
      options.timeoutMs ?? 15_000,
    );
    return node;
  } catch (error) {
    let output = "";
    if (node) {
      output = await stopNodeServer(node);
    }
    await rm(dataDir, { recursive: true, force: true });
    throw new Error(
      `Failed to start ${role} Mesh node${output ? `:\n${output}` : ""}`,
      { cause: error },
    );
  }
}

export async function restartMeshNode(
  node: ManagedMeshNode,
  timeoutMs: number = 15_000,
): Promise<void> {
  await stopNodeServer(node);
  const started = spawnNodeServer(node);
  node.child = started.child;
  node.output = started.output;
  node.generation += 1;
  try {
    await waitForNodeHealth(node, `${node.role} restart to become healthy`, timeoutMs);
  } catch (error) {
    const output = await stopNodeServer(node);
    throw new Error(
      `Failed to restart ${node.role} Mesh node${output ? `:\n${output}` : ""}`,
      { cause: error },
    );
  }
}

export async function stopMeshNode(node: ManagedMeshNode): Promise<void> {
  await stopNodeServer(node);
  await rm(node.dataDir, { recursive: true, force: true });
}

export async function meshJsonRequest<T>(
  node: MeshHttpNode,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    rawBody?: BodyInit;
    responseType?: "json" | "text";
  } = {},
): Promise<MeshJsonResponse<T>> {
  if (options.body !== undefined && options.rawBody !== undefined) {
    throw new Error("Mesh requests cannot include both JSON and raw bodies");
  }
  const method = options.method
    ?? (options.body === undefined && options.rawBody === undefined ? "GET" : "POST");
  const response = await fetch(`${node.baseUrl}${path}`, {
    method,
    headers: {
      ...(node.apiKey ? { authorization: `Bearer ${node.apiKey}` } : {}),
      ...(method === "GET" ? {} : { origin: node.baseUrl }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.rawBody
      ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    tls: node.tlsCertificate ? { ca: node.tlsCertificate } : undefined,
  });
  return {
    status: response.status,
    body: options.responseType === "text"
      ? await response.text() as T
      : await response.json() as T,
  };
}

export async function enrollMeshWorker(
  controller: MeshHttpNode,
  worker: ManagedMeshNode,
): Promise<MeshEnrollmentResult> {
  const created = await meshJsonRequest<MeshEnrollmentResult>(
    controller,
    "/api/mesh/enrollment-tokens",
    {
      method: "POST",
      body: { name: "integration", ttlSeconds: 900 },
    },
  );
  if (created.status !== 201) {
    throw new Error(
      `Failed to create Mesh enrollment token: ${created.status} ${JSON.stringify(created.body)}`,
    );
  }
  const fingerprint = created.body.enrollment?.controllerFingerprint;
  if (
    typeof created.body.token !== "string"
    || typeof fingerprint !== "string"
  ) {
    throw new Error("Mesh enrollment token response is incomplete");
  }

  const joinResult = Bun.spawnSync([
    ...worker.command,
    "worker",
    "join",
    controller.baseUrl,
    "--token",
    created.body.token,
    "--fingerprint",
    fingerprint,
  ], {
    cwd: rootDirectory,
    env: worker.environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (joinResult.exitCode !== 0) {
    const output = [
      joinResult.stdout.toString().trim(),
      joinResult.stderr.toString().trim(),
    ].filter((value) => value.length > 0).join("\n");
    throw new Error(`Worker enrollment failed: ${output || `exit code ${joinResult.exitCode}`}`);
  }
  return created.body;
}
