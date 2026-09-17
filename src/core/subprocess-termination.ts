/**
 * Platform-specific termination for Bun subprocess trees.
 */

import { win32 } from "node:path";
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

  const windows = process.platform === "win32";
  const gracefulTreeTermination = await requestSubprocessStop(subprocess, false);
  if (await waitForSubprocessExit(
    subprocess,
    options.gracefulWaitMs ?? DEFAULT_GRACEFUL_WAIT_MS,
  )) {
    if (windows && options.requireExit && !gracefulTreeTermination) {
      throwWindowsTreeTerminationGuaranteeError(subprocess);
    }
    return;
  }

  const forcedTreeTermination = await requestSubprocessStop(subprocess, true);
  const exited = await waitForSubprocessExit(
    subprocess,
    options.forceWaitMs ?? DEFAULT_FORCE_WAIT_MS,
  );
  if (!exited && options.requireExit) {
    throw new Error(
      `The subprocess tree did not exit after forced termination (pid ${String(subprocess.pid)}).`,
    );
  }
  if (windows && options.requireExit && !forcedTreeTermination) {
    throwWindowsTreeTerminationGuaranteeError(subprocess);
  }
}

async function requestSubprocessStop(
  subprocess: Bun.Subprocess,
  force: boolean,
): Promise<boolean> {
  if (process.platform === "win32") {
    return await terminateWindowsSubprocessTree(subprocess, force);
  }
  try {
    subprocess.kill(force ? "SIGKILL" : "SIGTERM");
    return true;
  } catch (error) {
    log.debug("Failed to signal subprocess while stopping it", {
      signal: force ? "SIGKILL" : "SIGTERM",
      error: String(error),
    });
    return false;
  }
}

async function terminateWindowsSubprocessTree(
  subprocess: Bun.Subprocess,
  force: boolean,
): Promise<boolean> {
  if (!Number.isInteger(subprocess.pid) || subprocess.pid <= 0) {
    tryKillSubprocessHandle(subprocess);
    return false;
  }
  const taskkill = resolveWindowsTaskkillExecutable();
  if (!taskkill) {
    tryKillSubprocessHandle(subprocess);
    return false;
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
    if (exitCode !== 0) {
      log.debug("Windows taskkill did not terminate the subprocess tree", {
        pid: subprocess.pid,
        force,
        exitCode,
      });
      if (force && subprocess.exitCode === null) {
        tryKillSubprocessHandle(subprocess);
      }
      return false;
    }
    return true;
  } catch (error) {
    log.debug("Failed to terminate Windows subprocess tree", {
      pid: subprocess.pid,
      force,
      error: String(error),
    });
    if (force) {
      tryKillSubprocessHandle(subprocess);
    }
    return false;
  }
}

function resolveWindowsTaskkillExecutable(): string | null {
  const resolved = Bun.which("taskkill.exe") ?? Bun.which("taskkill");
  if (resolved) {
    return resolved;
  }
  const windowsDirectory = process.env["SystemRoot"] ?? process.env["WINDIR"];
  return windowsDirectory
    ? win32.join(windowsDirectory, "System32", "taskkill.exe")
    : null;
}

function throwWindowsTreeTerminationGuaranteeError(
  subprocess: Bun.Subprocess,
): never {
  throw new Error(
    `The Windows subprocess exited, but process-tree termination could not be guaranteed (pid ${String(subprocess.pid)}).`,
  );
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
