import { isWebBundleReady } from "./dev-runtime";

const repoRoot = `${import.meta.dir}/../../..`;
const serverWorkspaceDir = `${repoRoot}/apps/server`;
const webWorkspaceDir = `${repoRoot}/apps/web`;
const webDistDir = `${webWorkspaceDir}/dist`;
const bunExecutable = process.execPath;
const WEB_BUNDLE_TIMEOUT_MS = 30000;
const WEB_BUNDLE_POLL_INTERVAL_MS = 100;

function spawnProcess(
  cmd: string[],
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Bun.Subprocess {
  return Bun.spawn({
    cmd,
    cwd,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
}

async function listWebDistEntries(): Promise<string[]> {
  const entries: string[] = [];
  for await (const entry of new Bun.Glob("*").scan({ cwd: webDistDir })) {
    entries.push(entry);
  }
  return entries;
}

async function waitForWebBundleReady(timeoutMs = WEB_BUNDLE_TIMEOUT_MS): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const entries = await listWebDistEntries();
    if (isWebBundleReady(entries)) {
      return;
    }
    await Bun.sleep(WEB_BUNDLE_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out waiting for the web bundle in ${webDistDir}. Expected index.html plus built JS/CSS assets.`,
  );
}

let stopping = false;

function stopProcess(process: Bun.Subprocess | undefined): void {
  if (!process || process.killed || process.exitCode !== null) {
    return;
  }
  process.kill();
}

async function main(): Promise<void> {
  const webBuilder = spawnProcess([bunExecutable, "--watch", "src/build.ts"], webWorkspaceDir);
  let server: Bun.Subprocess | undefined;

  const stopAll = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    stopProcess(server);
    stopProcess(webBuilder);
  };

  process.once("SIGINT", () => {
    stopAll();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    stopAll();
    process.exit(143);
  });

  try {
    await waitForWebBundleReady();

    server = spawnProcess(
      [bunExecutable, "--hot", "src/index.ts"],
      serverWorkspaceDir,
      {
        ...process.env,
        RALPHER_WEB_DIST_DIR: webDistDir,
      },
    );

    const completedProcess = await Promise.race([
      webBuilder.exited.then((code) => ({ code, label: "web build watcher" })),
      server.exited.then((code) => ({ code, label: "server" })),
    ]);

    stopAll();
    process.exit(completedProcess.code ?? 0);
  } catch (error) {
    stopAll();
    throw error;
  }
}

await main();
