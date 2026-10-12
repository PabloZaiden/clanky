/**
 * Network Devbox fixture owning real worker subprocesses and their teardown.
 */

import { chmod, mkdir } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { currentEnvironment, waitForExit } from "./process";
import { MESH_OPERATION_TIMEOUT_MS } from "./timeouts";

export async function startMeshDevboxFixture(binDirectory: string): Promise<{
  stop(): Promise<void>;
  diagnostics(): string;
}> {
  const binary = resolve(import.meta.dir, "../../../dist/clanky");
  const provider = resolve(import.meta.dir, "../providers/mesh-devbox.ts");
  const workers = new Map<string, ReturnType<typeof Bun.spawn>>();
  const outputs: string[] = [];
  const readers: Promise<void>[] = [];
  async function stopWorker(child: ReturnType<typeof Bun.spawn>): Promise<void> {
    if (child.exitCode === null) child.kill();
    if (!await waitForExit(child, MESH_OPERATION_TIMEOUT_MS)) {
      child.kill("SIGKILL");
      await child.exited;
      throw new Error(`Devbox worker ${child.pid} did not stop gracefully`);
    }
    await child.exited;
  }
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request: Request): Promise<Response> {
      try {
        const body = await request.json() as { directory: string };
        const root = join(body.directory, ".devbox", "clanky-worker");
        const previous = workers.get(body.directory);
        if (previous) await stopWorker(previous);
        await mkdir(join(root, "home"), { recursive: true });
        const child = Bun.spawn([binary, "serve", "--mesh-worker", "true", "--worker-directory", body.directory], {
          cwd: body.directory,
          env: currentEnvironment({
            CLANKY_DATA_DIR: join(root, "data"), CLANKY_HOST: "127.0.0.1",
            CLANKY_PORT: (await Bun.file(join(root, "devbox-port")).text()).trim(),
            CLANKY_PUBLIC_BASE_URL: "", CLANKY_DISABLE_PASSKEY: undefined,
            HOME: join(root, "home"), PATH: `${binDirectory}${delimiter}${process.env["PATH"] ?? ""}`,
            CLANKY_LOG_LEVEL: process.env["CLANKY_LOG_LEVEL"] ?? "fatal",
          }),
          stdout: "pipe", stderr: "pipe",
        });
        workers.set(body.directory, child);
        for (const stream of [child.stdout, child.stderr]) {
          if (!(stream instanceof ReadableStream)) continue;
          readers.push((async () => {
            for await (const chunk of stream) {
              outputs.push(Buffer.from(chunk).toString());
              if (outputs.length > 200) outputs.shift();
            }
          })());
        }
        await Bun.write(join(root, "worker.pid"), `${child.pid}\n`);
        return new Response("Worker launched");
      } catch (error) {
        return new Response(String(error), { status: 500 });
      }
    },
  });
  await mkdir(binDirectory, { recursive: true });
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const wrapper = join(binDirectory, "devbox");
  await Bun.write(wrapper, [
    "#!/bin/sh",
    `CLANKY_E2E_DEVBOX_SERVICE=${quote(`http://127.0.0.1:${server.port}`)} CLANKY_E2E_MESH_BINARY=${quote(binary)} exec ${quote(process.execPath)} ${quote(provider)} "$@"`,
    "",
  ].join("\n"));
  await chmod(wrapper, 0o700);
  return {
    diagnostics: () => [
      ...[...workers].map(([directory, child]) =>
        `Devbox worker: directory=${directory} pid=${child.pid} exitCode=${String(child.exitCode)} signalCode=${String(child.signalCode)}`),
      outputs.join(""),
    ].join("\n"),
    async stop(): Promise<void> {
      await server.stop(true);
      const results = await Promise.allSettled([...workers.values()].map(stopWorker));
      await Promise.all(readers);
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Devbox fixture cleanup failed");
    },
  };
}
