/**
 * Network Devbox fixture owning real worker subprocesses and their teardown.
 */

import { chmod, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { currentEnvironment, runCommand } from "./process";
import { MESH_OPERATION_TIMEOUT_MS } from "./timeouts";
import { renderExternalWorkerUpdateBinary } from "./provider";

async function githubReleaseResponse(path: string, binary: string | Bun.BunFile): Promise<Response> {
  const root = resolve(import.meta.dir, "../../..");
  if (/^\/raw\/pablozaiden\/installer\/[a-f0-9]{40}\/install.sh$/.test(path)) {
    return new Response(Bun.file(join(root, "node_modules", "@pablozaiden", "installer", "install.sh")));
  }
  if (path === "/raw/pablozaiden/clanky/main/.github/installer.json") {
    return new Response(Bun.file(join(root, ".github", "installer.json")));
  }
  if (path === "/api/repos/pablozaiden/clanky/releases/latest") {
    return Response.json({ tag_name: "v0.0.0-development" });
  }
  const latestVersion = "0.0.1-main-2026-01-01-00-00-abcdef0";
  const base = "/github/pablozaiden/clanky/releases/download";
  if (path === `${base}/latest/release.json`) {
    return Response.json({ schemaVersion: 1, channel: "latest", version: latestVersion, revision: "abcdef0".padEnd(40, "0") });
  }
  for (const [tag, version] of [["latest", latestVersion], ["v0.0.0-development", "0.0.0-development"]]) {
    const asset = `clanky-v${version}-${process.platform}-${process.arch}`;
    if (path === `${base}/${tag}/${asset}`) return new Response(binary);
    if (path === `${base}/${tag}/${asset}.sha256`) {
      const bytes = typeof binary === "string" ? binary : await binary.bytes();
      return new Response(`${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}  ${asset}\n`);
    }
  }
  return new Response(`No external GitHub fixture asset: ${path}`, { status: 404 });
}

export async function startMeshDevboxFixture(
  binDirectory: string,
  options: { updateStateDirectory?: string } = {},
): Promise<{
  stop(): Promise<void>;
  diagnostics(): string;
}> {
  const binary = resolve(import.meta.dir, "../../../dist/clanky");
  const curl = Bun.which("curl");
  if (!curl) throw new Error("The external GitHub release fixture requires curl.");
  const releaseBinary = options.updateStateDirectory ? renderExternalWorkerUpdateBinary() : Bun.file(binary);
  const workers = new Map<string, Record<string, string>>();
  const outputs: string[] = [];
  async function stopWorker(directory: string, environment: Record<string, string>): Promise<void> {
    const result = await runCommand(["sh", join(directory, ".devbox", "clanky-worker", "supervisor.sh"), "stop"], {
      cwd: directory, env: environment, timeoutMs: MESH_OPERATION_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) throw new Error(`Devbox worker cleanup failed: ${result.stderr}`);
  }
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request: Request): Promise<Response> {
      try {
        if (request.method === "GET") {
          return await githubReleaseResponse(new URL(request.url).pathname, releaseBinary);
        }
        const body = await request.json() as { directory: string };
        const root = join(body.directory, ".devbox", "clanky-worker");
        await mkdir(join(root, "home"), { recursive: true });
        const environment = currentEnvironment({
            CLANKY_DATA_DIR: join(root, "data"), CLANKY_HOST: "127.0.0.1",
            CLANKY_PORT: (await Bun.file(join(root, "devbox-port")).text()).trim(),
            CLANKY_PUBLIC_BASE_URL: "", CLANKY_DISABLE_PASSKEY: undefined,
            HOME: join(root, "home"), PATH: `${binDirectory}${delimiter}${process.env["PATH"] ?? ""}`,
            CLANKY_LOG_LEVEL: process.env["CLANKY_LOG_LEVEL"] ?? "fatal",
            CLANKY_E2E_WORKER_UPDATE_STATE_DIR: options.updateStateDirectory,
            CLANKY_E2E_WORKER_UPDATE_ID: options.updateStateDirectory ? "automatic-update" : undefined,
            CLANKY_E2E_WORKER_UPDATE_BINARY: join(root, "bin", "clanky-runtime"),
            CLANKY_E2E_MESH_BINARY: binary,
        });
        workers.set(body.directory, environment);
        const result = await runCommand(["sh", join(root, "launcher.sh")], {
          cwd: body.directory, env: environment, timeoutMs: MESH_OPERATION_TIMEOUT_MS,
        });
        outputs.push(result.stdout, result.stderr);
        if (outputs.length > 200) outputs.splice(0, outputs.length - 200);
        if (result.exitCode !== 0) throw new Error(`Devbox launcher failed: ${result.stderr}`);
        return new Response("Worker launched");
      } catch (error) {
        return new Response(String(error), { status: 500 });
      }
    },
  });
  try {
    await installDevboxPeers({
      binDirectory, binary, curl,
      serviceUrl: `http://127.0.0.1:${server.port}`,
      updateEnabled: !!options.updateStateDirectory,
    });
  } catch (error) {
    await server.stop(true).catch((cleanupError: unknown) => {
      throw new AggregateError([error, cleanupError], "Devbox fixture setup and cleanup failed");
    });
    throw error;
  }
  return {
    diagnostics: () => [
      ...[...workers.keys()].map((directory) => {
        const log = join(directory, ".devbox", "clanky-worker", "worker.log");
        return `Devbox worker: directory=${directory}\n${existsSync(log) ? readFileSync(log, "utf8").slice(-16 * 1024) : "No worker log"}`;
      }),
      outputs.join(""),
    ].join("\n"),
    async stop(): Promise<void> {
      await server.stop(true);
      const results = await Promise.allSettled([...workers].map(([directory, environment]) =>
        stopWorker(directory, environment)));
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Devbox fixture cleanup failed");
    },
  };
}

async function installDevboxPeers({
  binDirectory, binary, curl, serviceUrl, updateEnabled,
}: {
  binDirectory: string;
  binary: string;
  curl: string;
  serviceUrl: string;
  updateEnabled: boolean;
}): Promise<void> {
  await mkdir(binDirectory, { recursive: true });
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const wrapper = join(binDirectory, "devbox");
  const provider = resolve(import.meta.dir, "../providers/mesh-devbox.ts");
  await Bun.write(wrapper, [
    "#!/bin/sh",
    `CLANKY_E2E_DEVBOX_SERVICE=${quote(serviceUrl)} CLANKY_E2E_MESH_BINARY=${quote(binary)} CLANKY_E2E_UPDATE_ENABLED=${quote(String(updateEnabled))} exec ${quote(process.execPath)} ${quote(provider)} "$@"`,
    "",
  ].join("\n"));
  await chmod(wrapper, 0o700);
  const curlWrapper = join(binDirectory, "curl");
  const curlProvider = resolve(import.meta.dir, "../providers/github-release-curl.ts");
  await Bun.write(curlWrapper, [
    "#!/bin/sh",
    `CLANKY_E2E_GITHUB_RELEASE_SERVICE=${quote(serviceUrl)} CLANKY_E2E_REAL_CURL=${quote(curl)} exec ${quote(process.execPath)} ${quote(curlProvider)} "$@"`,
    "",
  ].join("\n"));
  await chmod(curlWrapper, 0o700);
}
