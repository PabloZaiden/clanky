/**
 * Platform-specific termination for Bun subprocess trees.
 */

import { createLogger } from "@pablozaiden/webapp/server";

const log = createLogger("core:subprocess-termination");
const DEFAULT_GRACEFUL_WAIT_MS = 250;
const DEFAULT_FORCE_WAIT_MS = 1_000;

export interface SubprocessTerminationOptions {
  gracefulWaitMs?: number;
  forceWaitMs?: number;
  requireExit?: boolean;
}

export async function terminateSubprocessTree(
  subprocess: Bun.Subprocess | null,
  options: SubprocessTerminationOptions = {},
): Promise<void> {
  if (!subprocess || subprocess.exitCode !== null) {
    return;
  }

  await requestSubprocessStop(subprocess, false);
  if (await waitForSubprocessExit(
    subprocess,
    options.gracefulWaitMs ?? DEFAULT_GRACEFUL_WAIT_MS,
  )) {
    return;
  }

  await requestSubprocessStop(subprocess, true);
  const exited = await waitForSubprocessExit(
    subprocess,
    options.forceWaitMs ?? DEFAULT_FORCE_WAIT_MS,
  );
  if (!exited && options.requireExit) {
    throw new Error(
      `The subprocess tree did not exit after forced termination (pid ${String(subprocess.pid)}).`,
    );
  }
}

async function requestSubprocessStop(
  subprocess: Bun.Subprocess,
  force: boolean,
): Promise<void> {
  if (process.platform === "win32") {
    await terminateWindowsSubprocessTree(subprocess, force);
    return;
  }
  try {
    subprocess.kill(force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    log.debug("Failed to signal subprocess while stopping it", {
      signal: force ? "SIGKILL" : "SIGTERM",
      error: String(error),
    });
  }
}

async function terminateWindowsSubprocessTree(
  subprocess: Bun.Subprocess,
  force: boolean,
): Promise<void> {
  if (!Number.isInteger(subprocess.pid) || subprocess.pid <= 0) {
    tryKillSubprocessHandle(subprocess);
    return;
  }
  const taskkill = Bun.which("taskkill.exe") ?? Bun.which("taskkill");
  if (!taskkill) {
    tryKillSubprocessHandle(subprocess);
    return;
  }
  try {
    const termination = Bun.spawn([
      taskkill,
      "/PID",
      String(subprocess.pid),
      "/T",
      ...(force ? ["/F"] : []),
    ], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = await termination.exited;
    if (exitCode !== 0 && subprocess.exitCode === null) {
      log.debug("Windows taskkill did not terminate the subprocess tree", {
        pid: subprocess.pid,
        force,
        exitCode,
      });
      if (force) {
        tryKillSubprocessHandle(subprocess);
      }
    }
  } catch (error) {
    log.debug("Failed to terminate Windows subprocess tree", {
      pid: subprocess.pid,
      force,
      error: String(error),
    });
    if (force) {
      tryKillSubprocessHandle(subprocess);
    }
  }
}

function tryKillSubprocessHandle(subprocess: Bun.Subprocess): void {
  try {
    subprocess.kill();
  } catch (error) {
    log.debug("Failed to terminate subprocess through its Bun handle", {
      error: String(error),
    });
  }
}

async function waitForSubprocessExit(
  subprocess: Bun.Subprocess,
  timeoutMs: number,
): Promise<boolean> {
  if (subprocess.exitCode !== null) {
    return true;
  }
  if (timeoutMs <= 0) {
    return subprocess.exitCode !== null;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exited = await Promise.race<boolean>([
      subprocess.exited.then(() => true, () => subprocess.exitCode !== null),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    return exited || subprocess.exitCode !== null;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
