import type { ChildProcess } from "node:child_process";

export async function waitForProcessStartup(child: ChildProcess, startupGraceMs = 500): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let stderr = "";
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    }, startupGraceMs);

    const cleanup = () => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stderr?.off("data", onStderr);
    };
    const onError = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(stderr.trim() || `Process exited early (code=${String(code)}, signal=${String(signal)})`));
    };
    const onStderr = (chunk: Buffer | string) => {
      stderr += chunk.toString();
    };

    child.on("error", onError);
    child.on("exit", onExit);
    child.stderr?.on("data", onStderr);
  });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });
}
