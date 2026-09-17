/**
 * Platform-specific termination for Bun subprocess trees.
 */

import { win32 } from "node:path";
import { createLogger } from "@pablozaiden/webapp/server";

const log = createLogger("core:subprocess-termination");
const DEFAULT_GRACEFUL_WAIT_MS = 250;
const DEFAULT_FORCE_WAIT_MS = 1_000;
const TASKKILL_REAP_WAIT_MS = 250;

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
  const gracefulWaitMs = options.gracefulWaitMs
    ?? DEFAULT_GRACEFUL_WAIT_MS;
  const gracefulDeadline = Date.now() + gracefulWaitMs;
  const gracefulTreeTermination = await requestSubprocessStop(
    subprocess,
    false,
    gracefulWaitMs,
  );
  if (await waitForSubprocessExit(
    subprocess,
    Math.max(0, gracefulDeadline - Date.now()),
  )) {
    if (windows && options.requireExit && !gracefulTreeTermination) {
      throwWindowsTreeTerminationGuaranteeError(subprocess);
    }
    return;
  }

  const forceWaitMs = options.forceWaitMs ?? DEFAULT_FORCE_WAIT_MS;
  const forceDeadline = Date.now() + forceWaitMs;
  const forcedTreeTermination = await requestSubprocessStop(
    subprocess,
    true,
    forceWaitMs,
  );
  const exited = await waitForSubprocessExit(
    subprocess,
    Math.max(0, forceDeadline - Date.now()),
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
  timeoutMs: number,
): Promise<boolean> {
  if (process.platform === "win32") {
    return await terminateWindowsSubprocessTree(
      subprocess,
      force,
      timeoutMs,
    );
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
  timeoutMs: number,
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
    const exitCode = await waitForSubprocessExitCode(termination, timeoutMs);
    if (exitCode === null) {
      log.warn("Windows taskkill helper timed out", {
        pid: subprocess.pid,
        force,
        timeoutMs,
      });
      tryKillTaskkillHelper(termination, subprocess.pid, force);
      if (
        await waitForSubprocessExitCode(termination, TASKKILL_REAP_WAIT_MS)
          === null
      ) {
        log.warn("Windows taskkill helper did not exit after termination", {
          pid: subprocess.pid,
          force,
        });
      }
      if (force && subprocess.exitCode === null) {
        tryKillSubprocessHandle(subprocess);
      }
      return false;
    }
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

function tryKillTaskkillHelper(
  termination: Bun.Subprocess,
  targetPid: number,
  force: boolean,
): void {
  try {
    termination.kill();
  } catch (error) {
    log.warn("Failed to terminate timed-out Windows taskkill helper", {
      pid: targetPid,
      force,
      error: String(error),
    });
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

async function waitForSubprocessExitCode(
  subprocess: Bun.Subprocess,
  timeoutMs: number,
): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<number | null>([
      subprocess.exited,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
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
