/**
 * Process primitives for black-box E2E scenarios.
 */

import { createServer, type AddressInfo } from "node:net";
import {
  LIFECYCLE_TIMEOUT_MS,
  OPERATION_TIMEOUT_MS,
  operationSignal,
} from "./timeouts";

const SHUTDOWN_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 50;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ManagedProcess {
  child: Bun.Subprocess;
  command: readonly string[];
  stdoutPath: string;
  stderrPath: string;
  processGroupId: number | null;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown })["code"];
  return typeof code === "string" ? code : undefined;
}

function isMissingProcess(error: unknown): boolean {
  return errorCode(error) === "ESRCH";
}

export function currentEnvironment(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (process.platform === "win32") {
      for (const inheritedName of Object.keys(environment)) {
        if (inheritedName.toLowerCase() === name.toLowerCase()) {
          delete environment[inheritedName];
        }
      }
    }
    if (value === undefined) {
      delete environment[name];
    } else {
      environment[name] = value;
    }
  }
  return environment;
}

export async function findFreeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Unable to determine a free loopback port");
  }
  const port = (address as AddressInfo).port;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
  return port;
}

export function startManagedProcess(
  command: readonly string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    stdoutPath: string;
    stderrPath: string;
  },
): ManagedProcess {
  const detached = process.platform !== "win32";
  const child = Bun.spawn({
    cmd: [...command],
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: Bun.file(options.stdoutPath),
    stderr: Bun.file(options.stderrPath),
    detached,
  });
  return {
    child,
    command,
    stdoutPath: options.stdoutPath,
    stderrPath: options.stderrPath,
    processGroupId: detached ? child.pid : null,
  };
}

export async function waitForExit(child: Bun.Subprocess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) {
    return true;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited.then(() => true),
      new Promise<boolean>((resolvePromise) => {
        timeout = setTimeout(() => resolvePromise(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function signalManagedProcess(process: ManagedProcess, signal: NodeJS.Signals): void {
  try {
    if (process.processGroupId !== null) {
      globalThis.process.kill(-process.processGroupId, signal);
    } else {
      process.child.kill(signal);
    }
  } catch (error) {
    if (!isMissingProcess(error)) {
      throw new Error(`Unable to send ${signal} to process ${String(process.child.pid)}`, { cause: error });
    }
  }
}

export async function stopManagedProcess(process: ManagedProcess): Promise<void> {
  if (process.child.exitCode !== null) {
    return;
  }
  signalManagedProcess(process, "SIGTERM");
  if (await waitForExit(process.child, SHUTDOWN_TIMEOUT_MS)) {
    return;
  }
  signalManagedProcess(process, "SIGKILL");
  if (!(await waitForExit(process.child, SHUTDOWN_TIMEOUT_MS))) {
    throw new Error(`Process ${String(process.child.pid)} did not exit after SIGKILL`);
  }
}

export async function readProcessDiagnostics(process: ManagedProcess): Promise<string> {
  const sections: string[] = [
    `command: ${process.command.join(" ")}`,
    `exit code: ${String(process.child.exitCode)}`,
  ];
  for (const [label, path] of [["stdout", process.stdoutPath], ["stderr", process.stderrPath]] as const) {
    const file = Bun.file(path);
    if (await file.exists()) {
      const contents = (await file.text()).trim();
      if (contents.length > 0) {
        sections.push(`${label}:\n${contents}`);
      }
    }
  }
  return sections.join("\n");
}

export async function runCommand(
  command: readonly string[],
  options: {
    cwd: string;
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
  },
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? OPERATION_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const child = Bun.spawn({
    cmd: [...command],
    cwd: options.cwd,
    env: options.env ?? currentEnvironment(),
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
    signal: controller.signal,
    killSignal: "SIGKILL",
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(
      new Error(
        `Command timed out after ${String(timeoutMs)}ms: ${command.join(" ")}`,
      ),
    );
  }, timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (timedOut) {
      throw new Error(
        `Command timed out after ${String(timeoutMs)}ms: ${command.join(" ")}`,
      );
    }
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export async function requireCommand(
  command: readonly string[],
  options: {
    cwd: string;
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
  },
): Promise<CommandResult> {
  const result = await runCommand(command, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${String(result.exitCode)}): ${command.join(" ")}\n${result.stderr.trim()}`,
    );
  }
  return result;
}

export async function waitForHttp(
  url: string,
  process: ManagedProcess,
  timeoutMs = LIFECYCLE_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "no request attempted";
  while (Date.now() <= deadline) {
    if (process.child.exitCode !== null) {
      throw new Error(`Process exited during startup\n${await readProcessDiagnostics(process)}`);
    }
    try {
      const response = await fetch(url, { signal: operationSignal() });
      if (response.ok) {
        return;
      }
      lastFailure = `HTTP ${String(response.status)}`;
    } catch (error) {
      lastFailure = String(error);
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Timed out waiting for ${url}: ${lastFailure}\n${await readProcessDiagnostics(process)}`,
  );
}
