import type { WebAppServerCommand } from "./create-web-app-cli";

interface ProcessCommandResult {
  status: number;
  stdout: string;
  stderr: string;
  notFound: boolean;
}

export interface PortInspection {
  pids: number[];
}

export interface ServerProcessPlatform {
  inspectPort(port: number): Promise<PortInspection>;
  readProcessCommand(pid: number): Promise<string | undefined>;
  isProcessAlive(pid: number): boolean;
  terminateProcess(pid: number, force: boolean): Promise<void>;
  spawnDetached(input: {
    command: WebAppServerCommand;
    cwd: string;
    environment: Record<string, string | undefined>;
    logFd: number;
  }): ReturnType<typeof Bun.spawn>;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

async function readProcessStream(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
): Promise<string> {
  if (!stream || typeof stream === "number") return "";
  return await new Response(stream).text();
}

async function runUtility(
  command: string,
  args: readonly string[],
): Promise<ProcessCommandResult> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { status: 127, stdout: "", stderr: "", notFound: true };
    }
    throw new Error(`Unable to run ${command}`, { cause: error });
  }
  const [stdout, stderr] = await Promise.all([
    readProcessStream(child.stdout),
    readProcessStream(child.stderr),
  ]);
  return {
    status: await child.exited,
    stdout,
    stderr,
    notFound: false,
  };
}

function parsePidList(output: string, source: string): number[] {
  const pids = new Set<number>();
  for (const value of output.split(/\s+/).filter(Boolean)) {
    if (!/^\d+$/.test(value)) {
      throw new Error(`${source} returned an invalid process id`);
    }
    const pid = Number(value);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error(`${source} returned an invalid process id`);
    }
    pids.add(pid);
  }
  return [...pids];
}

function parseSsPids(output: string): number[] {
  const pids = new Set<number>();
  for (const line of output.split("\n").map((value) => value.trim()).filter(Boolean)) {
    const matches = [...line.matchAll(/pid=(\d+)/g)];
    if (matches.length === 0) {
      throw new Error("ss could not identify the process listening on the configured port");
    }
    for (const match of matches) {
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error("ss returned an invalid process id");
      }
      pids.add(pid);
    }
  }
  return [...pids];
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw new Error(`Unable to inspect process ${String(pid)}`, { cause: error });
  }
}

function spawnDetached(input: {
  command: WebAppServerCommand;
  cwd: string;
  environment: Record<string, string | undefined>;
  logFd: number;
}): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([...input.command], {
    cwd: input.cwd,
    env: input.environment,
    detached: true,
    stdio: ["ignore", input.logFd, input.logFd],
  });
}

async function inspectPosixPort(port: number): Promise<PortInspection> {
  const lsof = await runUtility("lsof", [
    "-nP",
    "-a",
    `-iTCP:${String(port)}`,
    "-sTCP:LISTEN",
    "-t",
  ]);
  if (!lsof.notFound && (lsof.status === 0 || (lsof.status === 1 && !lsof.stderr.trim()))) {
    return { pids: parsePidList(lsof.stdout, "lsof") };
  }

  const ss = await runUtility("ss", ["-ltnpH", `sport = :${String(port)}`]);
  if (!ss.notFound && (ss.status === 0 || (ss.status === 1 && !ss.stderr.trim()))) {
    return { pids: parseSsPids(ss.stdout) };
  }

  const details = [lsof.stderr.trim(), ss.stderr.trim()].filter(Boolean).join("; ");
  throw new Error(
    `Unable to inspect the process listening on port ${String(port)}${details ? `: ${details}` : ""}`,
  );
}

async function readPosixProcessCommand(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") {
    try {
      const commandLine = new TextDecoder().decode(
        await Bun.file(`/proc/${String(pid)}/cmdline`).bytes(),
      );
      if (commandLine) return commandLine.replaceAll("\0", " ").trim() || undefined;
    } catch (error) {
      if (errorCode(error) !== "ENOENT" && errorCode(error) !== "EACCES") {
        throw new Error(`Unable to inspect process ${String(pid)}`, { cause: error });
      }
    }
  }
  const ps = await runUtility("ps", ["-p", String(pid), "-o", "command="]);
  if (ps.notFound) {
    throw new Error("Unable to inspect running processes because ps is unavailable");
  }
  if (ps.status !== 0) return undefined;
  return ps.stdout.trim() || undefined;
}

export function createServerProcessPlatform(): ServerProcessPlatform {
  return {
    inspectPort: inspectPosixPort,
    readProcessCommand: readPosixProcessCommand,
    isProcessAlive: processIsAlive,
    terminateProcess: async (pid, force) => {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    },
    spawnDetached,
  };
}
