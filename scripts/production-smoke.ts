/**
 * Build and smoke-test the compiled Clanky production binary.
 */

import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runProductionHttpSmoke } from "./production-smoke-http";

const ROOT_DIR = resolve(import.meta.dir, "..");
const BINARY_PATH = resolve(ROOT_DIR, "dist", "clanky");
const PROCESS_GRACE_PERIOD_MS = 3_000;
const PROCESS_FORCE_PERIOD_MS = 3_000;
const PROCESS_POLL_INTERVAL_MS = 50;

interface ManagedProcess {
  child: Bun.Subprocess;
  processGroupId: number;
}

interface SmokeLogPaths {
  buildStdout: string;
  buildStderr: string;
  serverStdout: string;
  serverStderr: string;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown })["code"];
  return typeof code === "string" ? code : undefined;
}

function isMissingProcessError(error: unknown): boolean {
  return errorCode(error) === "ESRCH";
}

function processEnvironment(overrides: Record<string, string>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return {
    ...environment,
    ...overrides,
  };
}

function spawnDetached(
  command: readonly string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    stdout: Bun.BunFile;
    stderr: Bun.BunFile;
  },
): ManagedProcess {
  const child = Bun.spawn({
    cmd: [...command],
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: options.stdout,
    stderr: options.stderr,
    detached: true,
  });
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The subprocess has no usable PID, so there is no process group to target.
    }
    throw new Error("Detached subprocess did not provide a valid process-group identifier");
  }
  return {
    child,
    processGroupId: child.pid,
  };
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) {
      return false;
    }
    const code = errorCode(error);
    if (code === "EPERM") {
      return true;
    }
    throw error;
  }
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw new Error(
        `Unable to send ${signal} to smoke process group ${String(processGroupId)}`,
        { cause: error },
      );
    }
  }
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await condition()) {
      return true;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return false;
    }
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, Math.min(PROCESS_POLL_INTERVAL_MS, remaining));
    });
  }
}

async function waitForProcessExit(
  child: Bun.Subprocess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) {
    return true;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited.then(() => true),
      new Promise<boolean>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function waitForProcessGroupGone(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  return await waitForCondition(
    () => !processGroupExists(processGroupId),
    timeoutMs,
  );
}

async function terminateProcessGroup(
  managedProcess: ManagedProcess,
): Promise<void> {
  if (processGroupExists(managedProcess.processGroupId)) {
    signalProcessGroup(managedProcess.processGroupId, "SIGTERM");
  }

  let groupGone = await waitForProcessGroupGone(
    managedProcess.processGroupId,
    PROCESS_GRACE_PERIOD_MS,
  );
  if (!groupGone) {
    signalProcessGroup(managedProcess.processGroupId, "SIGKILL");
    groupGone = await waitForProcessGroupGone(
      managedProcess.processGroupId,
      PROCESS_FORCE_PERIOD_MS,
    );
  }

  const childExited = await waitForProcessExit(
    managedProcess.child,
    PROCESS_FORCE_PERIOD_MS,
  );
  if (!groupGone || !childExited) {
    throw new Error(
      `Smoke process group ${String(managedProcess.processGroupId)} did not terminate completely`,
    );
  }
}

async function findFreeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Unable to determine the dynamically allocated smoke port");
  }
  const port = (address as AddressInfo).port;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolvePromise();
      }
    });
  });
  return port;
}

async function createRunDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clanky-production-smoke-"));
  await chmod(directory, 0o700);
  return directory;
}

function getLogPaths(runDirectory: string): SmokeLogPaths {
  return {
    buildStdout: join(runDirectory, "build.stdout.log"),
    buildStderr: join(runDirectory, "build.stderr.log"),
    serverStdout: join(runDirectory, "server.stdout.log"),
    serverStderr: join(runDirectory, "server.stderr.log"),
  };
}

async function runBuild(
  logPaths: SmokeLogPaths,
  signal: AbortSignal,
): Promise<void> {
  const build = spawnDetached(
    [process.execPath, "run", "build"],
    {
      cwd: ROOT_DIR,
      env: processEnvironment({}),
      stdout: Bun.file(logPaths.buildStdout),
      stderr: Bun.file(logPaths.buildStderr),
    },
  );
  const abortBuild = () => {
    try {
      signalProcessGroup(build.processGroupId, "SIGTERM");
    } catch (error) {
      console.error(`Unable to stop the build process after interruption: ${formatError(error)}`);
    }
  };
  signal.addEventListener("abort", abortBuild, { once: true });

  try {
    const exitCode = await build.child.exited;
    if (signal.aborted) {
      throw new Error("Production build was interrupted");
    }
    if (exitCode !== 0) {
      throw new Error(`Production build exited with code ${String(exitCode)}`);
    }
  } finally {
    signal.removeEventListener("abort", abortBuild);
    if (processGroupExists(build.processGroupId)) {
      await terminateProcessGroup(build);
    }
  }
}

async function requireProductionBinary(): Promise<void> {
  let metadata;
  try {
    metadata = await stat(BINARY_PATH);
  } catch (error) {
    throw new Error(`Production build did not create ${BINARY_PATH}`, { cause: error });
  }
  if (!metadata.isFile()) {
    throw new Error(`Production build output is not a regular file: ${BINARY_PATH}`);
  }
  if ((metadata.mode & 0o111) === 0) {
    throw new Error(`Production build output is not executable: ${BINARY_PATH}`);
  }
}

function startProductionServer(
  runDirectory: string,
  port: number,
  dataDirectory: string,
): ManagedProcess {
  return spawnDetached(
    [BINARY_PATH, "serve"],
    {
      cwd: ROOT_DIR,
      env: processEnvironment({
        CLANKY_DATA_DIR: dataDirectory,
        CLANKY_DISABLE_PASSKEY: "true",
        CLANKY_HOST: "127.0.0.1",
        CLANKY_PORT: String(port),
        NODE_ENV: "production",
      }),
      stdout: Bun.file(join(runDirectory, "server.stdout.log")),
      stderr: Bun.file(join(runDirectory, "server.stderr.log")),
    },
  );
}

function assertProductionServerRunning(server: ManagedProcess): void {
  if (server.child.exitCode !== null) {
    throw new Error(
      `Production binary exited during startup with code ${String(server.child.exitCode)}`,
    );
  }
}

async function printLogs(
  logPaths: SmokeLogPaths,
  failure: unknown,
): Promise<void> {
  console.error(`Production smoke failed: ${formatError(failure)}`);
  for (const [label, path] of Object.entries(logPaths)) {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      continue;
    }
    const contents = await file.text();
    if (contents.trim().length === 0) {
      continue;
    }
    console.error(`--- ${label}: ${path} ---`);
    console.error(contents.trimEnd());
    console.error(`--- end ${label} ---`);
  }
}

function combineFailures(primary: unknown, cleanup: unknown): Error {
  if (primary === undefined) {
    return cleanup instanceof Error ? cleanup : new Error(String(cleanup));
  }
  return new Error(
    `${formatError(primary)}; smoke cleanup failed: ${formatError(cleanup)}`,
    { cause: cleanup },
  );
}

async function runProductionSmoke(): Promise<void> {
  const controller = new AbortController();
  let interruptedBy: "SIGINT" | "SIGTERM" | undefined;
  const onSigint = () => {
    interruptedBy = "SIGINT";
    controller.abort(new Error("Production smoke received SIGINT"));
  };
  const onSigterm = () => {
    interruptedBy = "SIGTERM";
    controller.abort(new Error("Production smoke received SIGTERM"));
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  let runDirectory: string | undefined;
  let logPaths: SmokeLogPaths | undefined;
  let server: ManagedProcess | undefined;
  let failure: unknown;

  try {
    runDirectory = await createRunDirectory();
    logPaths = getLogPaths(runDirectory);
    const dataDirectory = join(runDirectory, "data");
    await mkdir(dataDirectory, { mode: 0o700 });

    await runBuild(logPaths, controller.signal);
    await requireProductionBinary();

    const port = await findFreeLoopbackPort();
    server = startProductionServer(runDirectory, port, dataDirectory);
    await runProductionHttpSmoke({
      baseUrl: `http://127.0.0.1:${String(port)}`,
      signal: controller.signal,
      ensureProcessRunning: () => {
        if (server !== undefined) {
          assertProductionServerRunning(server);
        }
      },
    });
    if (interruptedBy !== undefined) {
      throw new Error(`Production smoke was interrupted by ${interruptedBy}`);
    }
  } catch (error) {
    failure = error;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);

    if (server !== undefined) {
      try {
        await terminateProcessGroup(server);
      } catch (error) {
        failure = combineFailures(failure, error);
      }
    }

    if (failure !== undefined && logPaths !== undefined) {
      await printLogs(logPaths, failure);
    }

    if (runDirectory !== undefined) {
      try {
        await rm(runDirectory, { recursive: true, force: true });
      } catch (error) {
        failure = combineFailures(failure, error);
        console.error(`Unable to remove smoke run directory ${runDirectory}: ${formatError(error)}`);
      }
    }
  }

  if (failure !== undefined) {
    throw failure;
  }
}

if (import.meta.main) {
  try {
    await runProductionSmoke();
    console.log("Production binary smoke test passed");
  } catch (error) {
    console.error(`Production binary smoke test failed: ${formatError(error)}`);
    process.exitCode = 1;
  }
}
