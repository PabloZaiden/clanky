/**
 * External Devbox command peer backed by real compiled Mesh worker processes.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const root = join(process.cwd(), ".devbox", "clanky-worker");
const portFile = join(root, "devbox-port");
const marker = join(root, "devbox-running");
const serviceUrl = process.env["CLANKY_E2E_DEVBOX_SERVICE"]!;

async function service(operation: string): Promise<void> {
  const response = await fetch(`${serviceUrl}/${operation}`, {
    method: "POST",
    body: JSON.stringify({ directory: process.cwd() }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(await response.text());
}

if (args[0] === "--help") {
  console.log("External Mesh Devbox fixture");
} else if (args[0] === "up" || args[0] === "rebuild") {
  await mkdir(join(root, "bin"), { recursive: true });
  if (!await Bun.file(portFile).exists()) {
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    await Bun.write(portFile, String(listener.port));
    listener.stop(true);
  }
  const binary = join(root, "bin", "clanky");
  if (!await Bun.file(binary).exists()) {
    await Bun.write(binary, Bun.file(process.env["CLANKY_E2E_MESH_BINARY"]!));
    const result = Bun.spawnSync(["chmod", "755", binary], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }
  await Bun.write(marker, "running");
  console.log(`Devbox ${args[0]} completed`);
} else if (args[0] === "status") {
  const port = Number(await Bun.file(portFile).text());
  console.log(JSON.stringify({
    running: await Bun.file(marker).exists(), ports: [port],
    sshEnabled: false, password: null, workdir: process.cwd(),
    sshUser: null, sshPort: null, remoteUser: null,
    hasCredentialFile: false, credentialPath: "",
    publishedPorts: { [`${port}/tcp`]: [{ hostIp: "127.0.0.1", hostPort: port }] },
  }));
} else if (args[0] === "exec" && args[1] === "--") {
  const command = args.slice(2);
  if (command[0] === "sh" && command[1] === join(root, "launcher.sh")) {
    await service("start");
  } else {
    const child = Bun.spawn(command, {
      cwd: process.cwd(), env: {
        ...process.env, CLANKY_PUBLIC_BASE_URL: "",
        HOME: join(root, "home"),
      },
      stdout: "inherit", stderr: "inherit",
      timeout: 5_000, killSignal: "SIGKILL",
    });
    process.exitCode = await child.exited;
  }
} else {
  throw new Error(`Unsupported Mesh Devbox command: ${args.join(" ")}`);
}
