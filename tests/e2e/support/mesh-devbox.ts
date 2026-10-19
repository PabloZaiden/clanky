/**
 * Network Devbox fixture owning real worker subprocesses and their teardown.
 */

import { chmod, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { currentEnvironment, runCommand } from "./process";
import { MESH_OPERATION_TIMEOUT_MS } from "./timeouts";

export async function startMeshDevboxFixture(
  binDirectory: string,
  options: { updateStateDirectory?: string } = {},
): Promise<{
  stop(): Promise<void>;
  diagnostics(): string;
}> {
  const binary = resolve(import.meta.dir, "../../../dist/clanky");
  const provider = resolve(import.meta.dir, "../providers/mesh-devbox.ts");
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
  await mkdir(binDirectory, { recursive: true });
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const wrapper = join(binDirectory, "devbox");
  const updateProvider = resolve(import.meta.dir, "../providers/worker-update-command.ts");
  await Bun.write(wrapper, [
    "#!/bin/sh",
    `CLANKY_E2E_DEVBOX_SERVICE=${quote(`http://127.0.0.1:${server.port}`)} CLANKY_E2E_MESH_BINARY=${quote(binary)} CLANKY_E2E_UPDATE_COMMAND=${quote(updateProvider)} CLANKY_E2E_UPDATE_ENABLED=${quote(String(!!options.updateStateDirectory))} exec ${quote(process.execPath)} ${quote(provider)} "$@"`,
    "",
  ].join("\n"));
  await chmod(wrapper, 0o700);
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
