import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const stateDirectory = process.env["CLANKY_E2E_WORKER_UPDATE_STATE_DIR"];
const workerId = process.env["CLANKY_E2E_WORKER_UPDATE_ID"];

if (!stateDirectory || !workerId) {
  throw new Error("Worker update fixture environment is incomplete.");
}

const workerStateDirectory = join(stateDirectory, workerId);
await mkdir(workerStateDirectory, { recursive: true });

if (args[0] === "update"
  && (args.length === 1 || (args.length === 3 && args[1] === "--channel"
    && (args[2] === "stable" || args[2] === "latest")))) {
  await Bun.write(join(workerStateDirectory, "update-started"), "started");
  console.log("Deterministic worker update started.");

  const releasePath = join(stateDirectory, "release-update");
  const deadline = performance.now() + 45_000;
  while (!await Bun.file(releasePath).exists()) {
    if (performance.now() >= deadline) {
      throw new Error("Timed out waiting for the worker update fixture release.");
    }
    await Bun.sleep(25);
  }

  if (process.env["CLANKY_E2E_WORKER_UPDATE_FAIL"] === "true") {
    console.error("Deterministic worker update failed.");
    process.exitCode = 42;
  } else {
    const target = process.env["CLANKY_E2E_WORKER_UPDATE_BINARY"];
    if (target) {
      const source = process.env["CLANKY_E2E_MESH_BINARY"];
      if (!source) throw new Error("The external release binary is missing.");
      const staged = `${target}.release`;
      await copyFile(source, staged);
      await chmod(staged, 0o755);
      await rename(staged, target);
    }
    console.log("Deterministic worker update succeeded.");
  }
} else if (args.join(" ") === "worker service restart") {
  const release = new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
  });
  await rm(join(workerStateDirectory, "service-running"), { force: true });
  await Bun.write(join(workerStateDirectory, "restart-started"), "started");
  console.log("Deterministic worker service restart invoked.");
  await release;
} else if (args.join(" ") === "worker service status") {
  const binary = process.env["CLANKY_E2E_MESH_BINARY"];
  if (!binary) throw new Error("The external worker binary is missing.");
  const status = Bun.spawn([binary, "worker", "channel"], { stdout: "pipe", stderr: "inherit" });
  const channel = await new Response(status.stdout).json() as { releaseChannel: string };
  if (await status.exited !== 0) throw new Error("Cannot read the worker's saved channel.");
  console.log(JSON.stringify({
    installed: true,
    running: !await Bun.file(join(workerStateDirectory, "restart-started")).exists()
      || await Bun.file(join(workerStateDirectory, "service-running")).exists(),
    instanceId: process.env["CLANKY_WORKER_INSTANCE_ID"],
    binaryVersion: process.env["CLANKY_WORKER_RUNNING_VERSION"],
    runningVersion: process.env["CLANKY_WORKER_RUNNING_VERSION"],
    releaseChannel: channel.releaseChannel,
  }));
} else if (args[0] === "worker" && args[1] === "channel") {
  const binary = process.env["CLANKY_E2E_MESH_BINARY"];
  if (!binary) throw new Error("The external worker binary is missing.");
  const child = Bun.spawn([binary, ...args], { stdout: "inherit", stderr: "inherit" });
  process.exitCode = await child.exited;
} else {
  throw new Error(`Unexpected worker update fixture command: ${args.join(" ")}`);
}
