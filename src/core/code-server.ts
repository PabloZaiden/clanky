/**
 * Owns one execution-host VS Code process tree and its temporary credentials.
 */

import { posix, win32 } from "node:path";
import type { CommandExecutor, CommandResult } from "./command-executor";
import { DomainError, isDomainError } from "../domain/domain-error";
import { CODE_PROCESS_CLEANUP, CODE_PROCESS_WRAPPER } from "./code-process-supervision";

const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface CodeServer {
  port: number;
  directory: string;
  token: string;
  exited: Promise<void>;
  close(): Promise<void>;
}

async function createSessionDirectory(executor: CommandExecutor, directory: string): Promise<string> {
  const result = executor.pathStyle === "windows"
    ? await executor.exec("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        '$p = Join-Path ([IO.Path]::GetTempPath()) $env:CLANKY_CODE_TEMP_NAME; New-Item -ItemType Directory -Path $p -ErrorAction Stop | Out-Null; Write-Output $p',
      ], {
        cwd: directory, timeout: 5_000, logFailures: false,
        env: { CLANKY_CODE_TEMP_NAME: `clanky-code-${crypto.randomUUID()}` },
      })
    : await executor.exec("sh", ["-c", 'umask 077; exec mktemp -d "${TMPDIR:-/tmp}/clanky-code-XXXXXXXX"'], {
        cwd: directory, timeout: 5_000, logFailures: false,
      });
  const path = result.stdout.trim();
  const paths = executor.pathStyle === "windows" ? win32 : posix;
  if (!result.success || !paths.isAbsolute(path) || !/^clanky-code-[\w-]+$/.test(paths.basename(path))) {
    throw new DomainError("code_start_failed", "Unable to create a private VS Code session directory.");
  }
  return path;
}

async function assertCodeAvailable(executor: CommandExecutor, directory: string, signal: AbortSignal): Promise<void> {
  const help = await executor.exec("code", ["serve-web", "--help"], {
    cwd: directory, timeout: 5_000, signal, logFailures: false, maxOutputBytes: 64 * 1024,
  });
  if (!help.success || !["--connection-token-file", "--default-folder", "--port"].every((flag) => help.stdout.includes(flag))) {
    throw new DomainError("code_unavailable", "This workspace host needs a code CLI that supports serve-web. VS Code was not installed or replaced.");
  }
  if (executor.pathStyle !== "windows") {
    const bash = await executor.exec("bash", ["--version"], { cwd: directory, timeout: 5_000, signal, logFailures: false });
    if (!bash.success) {
      throw new DomainError("code_runtime_unavailable", "VS Code sessions require bash on POSIX workspace hosts for process-tree cleanup.");
    }
  }
}

function launchCodeProcess(options: {
  executor: CommandExecutor;
  directory: string;
  args: string[];
  pidPath: string;
  cleanupPath: string;
  signal: AbortSignal;
}): { run: Promise<CommandResult>; listening: Promise<number> } {
  let output = "";
  let resolvePort!: (port: number) => void;
  const listening = new Promise<number>((resolve) => { resolvePort = resolve; });
  const run = options.executor.exec(
    options.executor.pathStyle === "windows" ? "code" : "bash",
    options.executor.pathStyle === "windows" ? options.args : ["-c", CODE_PROCESS_WRAPPER, "clanky-code", "code", ...options.args],
    {
      cwd: options.directory, timeout: null, signal: options.signal,
      env: { CLANKY_CODE_PID_FILE: options.pidPath, CLANKY_CODE_CLEANUP_FILE: options.cleanupPath },
      longRunning: true, logFailures: false, maxOutputBytes: MAX_OUTPUT_BYTES,
      onStdoutChunk(chunk) {
        output = `${output}${chunk}`.slice(-8192);
        const match = /Web UI available at http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
        if (match) {
          const port = Number(match[1]);
          if (port > 0 && port <= 65535) resolvePort(port);
        }
      },
    },
  );
  return { run, listening };
}

async function stopCodeProcess(options: {
  executor: CommandExecutor;
  directory: string;
  pidPath: string;
  cleanupPath: string;
  controller: AbortController;
  run: Promise<CommandResult> | undefined;
}): Promise<void> {
  const { executor, directory, pidPath, cleanupPath, controller, run } = options;
  let stopped = false;
  if (run && executor.pathStyle !== "windows") {
    const result = await executor.exec("bash", [cleanupPath, pidPath], {
      cwd: directory, timeout: 5_000, logFailures: false,
    });
    if (!result.success) {
      throw new DomainError("code_cleanup_failed", "VS Code process-tree cleanup could not be confirmed.");
    }
    stopped = true;
  } else {
    controller.abort();
  }
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const result = await run;
    if (result?.termination === "failed"
      || (executor.pathStyle === "windows" && result && !result.success && result.termination !== "confirmed")) {
      throw new DomainError("code_cleanup_failed", "VS Code process-tree cleanup could not be confirmed.");
    }
  } catch (error) {
    const confirmedCancellation = isDomainError(error)
      && error.code === "mesh_execution_aborted"
      && (stopped || error.details["terminationConfirmed"] === true);
    if (!(controller.signal.aborted && confirmedCancellation)) {
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function startCodeServer(options: {
  executor: CommandExecutor;
  directory: string;
  acceptServerLicenseTerms: boolean;
  signal: AbortSignal;
}): Promise<CodeServer> {
  const { executor, directory, signal } = options;
  signal.throwIfAborted();
  await assertCodeAvailable(executor, directory, signal);
  const temporaryDirectory = await createSessionDirectory(executor, directory);
  const paths = executor.pathStyle === "windows" ? win32 : posix;
  const token = crypto.randomUUID().replaceAll("-", "");
  const tokenPath = paths.join(temporaryDirectory, "token");
  const pidPath = paths.join(temporaryDirectory, "process");
  const cleanupPath = paths.join(temporaryDirectory, "cleanup.sh");
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let run: Promise<CommandResult> | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    try {
      await stopCodeProcess({ executor, directory, pidPath, cleanupPath, controller, run });
    } finally {
      controller.abort();
      signal.removeEventListener("abort", abort);
      if (!(await executor.deletePath(temporaryDirectory, { kind: "directory", recursive: true }))) {
        throw new DomainError("code_cleanup_failed", "Unable to remove the VS Code session directory.");
      }
    }
  })();

  try {
    if (!(await executor.writeFile(tokenPath, token))) {
      throw new DomainError("code_start_failed", "Unable to write the VS Code session credential.");
    }
    if (executor.pathStyle !== "windows") {
      if (!(await executor.writeFile(cleanupPath, CODE_PROCESS_CLEANUP))) {
        throw new DomainError("code_start_failed", "Unable to write the VS Code process cleanup script.");
      }
      const cleanupCheck = await executor.exec("bash", [cleanupPath, pidPath], {
        cwd: directory, timeout: 5_000, signal: controller.signal, logFailures: false,
      });
      if (!cleanupCheck.success) {
        throw new DomainError("code_runtime_unavailable", `VS Code sessions require process inspection with bash, ps, awk, and sort on this workspace host (exit ${cleanupCheck.exitCode}).`);
      }
    }
    controller.signal.throwIfAborted();
    const args = [
      "serve-web", "--host", "127.0.0.1", "--port", "0",
      "--connection-token-file", tokenPath,
      "--server-data-dir", paths.join(temporaryDirectory, "server"),
      "--default-folder", directory, "--log", "warn",
      ...(options.acceptServerLicenseTerms ? ["--accept-server-license-terms"] : []),
    ];
    const launched = launchCodeProcess({ executor, directory, args, pidPath, cleanupPath, signal: controller.signal });
    run = launched.run;
    // The owner handles every exit identically; close still awaits the original outcome.
    const exited = run.then(() => undefined, () => undefined);
    const port = await Promise.race([
      launched.listening,
      run.then(() => {
        throw new DomainError(
          "code_start_failed",
          options.acceptServerLicenseTerms
            ? "VS Code stopped before its web listener was ready."
            : "VS Code could not start. If license consent is required, review https://aka.ms/vscode-server-license and repeat with --accept-server-license-terms.",
        );
      }),
    ]);
    return { port, directory, token, exited, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new DomainError("code_cleanup_failed", "Failed VS Code startup could not clean up its owned resources.", {
        cause: new AggregateError([error, cleanupError]),
      });
    }
    signal.throwIfAborted();
    throw error;
  }
}

export async function waitForCodeEditor(server: CodeServer, baseUrl: string, signal: AbortSignal): Promise<void> {
  let cookie = "";
  while (!signal.aborted) {
    const url = new URL(baseUrl);
    if (!cookie) url.searchParams.set("tkn", server.token);
    const response = await fetch(url, {
      headers: cookie ? { cookie } : undefined,
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    });
    if (response.status === 200) {
      const html = await response.text();
      if (html.includes("workbench")) return;
      throw new DomainError("code_start_failed", "VS Code did not serve its editor.");
    }
    await response.body?.cancel();
    if (response.status === 302) {
      cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
      if (cookie) continue;
    }
    if (response.status !== 202) {
      throw new DomainError("code_start_failed", "VS Code editor initialization failed. Check the workspace host's network access and system requirements.");
    }
    await Bun.sleep(100);
  }
  signal.throwIfAborted();
}
