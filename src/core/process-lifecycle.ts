import type { ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";

export async function waitForProcessTcpListener(
  child: ChildProcess,
  options: { host: string; port: number; timeoutMs: number; signal?: AbortSignal },
): Promise<void> {
  options.signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    let socket: Socket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => finish(new Error("Process TCP listener startup timed out")), options.timeoutMs);
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      if (retry) clearTimeout(retry);
      socket?.destroy();
      child.off("exit", onExit);
      child.off("error", onError);
      options.signal?.removeEventListener("abort", onAbort);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const onExit = () => finish(new Error("Process exited before its TCP listener was ready"));
    const onError = (error: Error) => finish(error);
    const onAbort = () => finish(options.signal?.reason);
    const probe = () => {
      if (finished) return;
      if (child.exitCode !== null || child.signalCode !== null) {
        onExit();
        return;
      }
      socket = createConnection({ host: options.host, port: options.port });
      socket.once("connect", () => finish());
      socket.once("error", (error: NodeJS.ErrnoException) => {
        if (finished) return;
        if (error.code !== "ECONNREFUSED") {
          finish(error);
          return;
        }
        retry = setTimeout(probe, 50);
      });
    };
    child.once("exit", onExit);
    child.once("error", onError);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    probe();
  });
}

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
