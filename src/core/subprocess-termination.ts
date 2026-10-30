import { createLogger } from "@pablozaiden/webapp/server";

const log = createLogger("core:subprocess-termination");
const DEFAULT_GRACEFUL_WAIT_MS = 250;
const DEFAULT_FORCE_WAIT_MS = 1_000;

export class SubprocessTreeTerminationError extends Error {
  override readonly name = "SubprocessTreeTerminationError";

  constructor(message: string, readonly retryable: boolean, options?: ErrorOptions) {
    super(message, options);
  }
}

export interface SubprocessTerminationOptions {
  gracefulWaitMs?: number;
  forceWaitMs?: number;
  requireExit?: boolean;
}

export async function terminateSubprocessTree(
  subprocess: Bun.Subprocess | null,
  options: SubprocessTerminationOptions = {},
): Promise<void> {
  if (!subprocess || subprocess.exitCode !== null) return;
  const gracefulWaitMs = options.gracefulWaitMs ?? DEFAULT_GRACEFUL_WAIT_MS;
  const gracefulDeadline = Date.now() + gracefulWaitMs;
  requestSubprocessStop(subprocess, false);
  if (await waitForSubprocessExit(subprocess, Math.max(0, gracefulDeadline - Date.now()))) return;

  const forceWaitMs = options.forceWaitMs ?? DEFAULT_FORCE_WAIT_MS;
  const forceDeadline = Date.now() + forceWaitMs;
  requestSubprocessStop(subprocess, true);
  if (!await waitForSubprocessExit(subprocess, Math.max(0, forceDeadline - Date.now())) && options.requireExit) {
    throw new SubprocessTreeTerminationError(
      `The subprocess tree did not exit after forced termination (pid ${String(subprocess.pid)}).`,
      true,
    );
  }
}

function requestSubprocessStop(subprocess: Bun.Subprocess, force: boolean): void {
  if (subprocess.exitCode !== null) return;
  try {
    subprocess.kill(force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    log.debug("Failed to signal subprocess while stopping it", {
      signal: force ? "SIGKILL" : "SIGTERM",
      error: String(error),
    });
  }
}

async function waitForSubprocessExit(subprocess: Bun.Subprocess, timeoutMs: number): Promise<boolean> {
  if (subprocess.exitCode !== null) return true;
  if (timeoutMs <= 0) return subprocess.exitCode !== null;
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
    if (timer !== undefined) clearTimeout(timer);
  }
}
