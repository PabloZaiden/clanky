/**
 * Owns one execution-host VS Code process tree and its temporary credentials.
 */

import { posix as paths } from "node:path";
import type { CommandExecutor, CommandResult } from "./command-executor";
import { DomainError, isDomainError } from "../domain/domain-error";
import { CODE_PROCESS_CLEANUP, CODE_PROCESS_WRAPPER } from "./code-process-supervision";
import type { CodePreviewCleanup } from "@/shared/preview";
import { prepareCodeSession, cleanupCodeSession } from "./code-session-resources";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const CODE_ENV = { DONT_PROMPT_WSL_INSTALL: "1" };

export interface CodeServer {
  port: number;
  directory: string;
  token: string;
  exited: Promise<void>;
  close(): Promise<void>;
}

async function assertCodeAvailable(executor: CommandExecutor, directory: string, signal: AbortSignal): Promise<void> {
  const help = await executor.exec("code", ["serve-web", "--help"], {
    cwd: directory, timeout: 5_000, signal, env: CODE_ENV, logFailures: false, maxOutputBytes: 64 * 1024,
  });
  signal.throwIfAborted();
  if (!help.success) {
    const lookup = await executor.exec(
      "sh",
      ["-c", "command -v code >/dev/null 2>&1 || exit 1"],
      { cwd: directory, timeout: 5_000, signal, logFailures: false },
    );
    signal.throwIfAborted();
    if (!lookup.success && lookup.exitCode === 1) {
      throw new DomainError("code_unavailable", "The code CLI was not found in PATH on the selected workspace host. Install a VS Code CLI that supports serve-web or update the host's PATH.");
    }
    throw new DomainError(
      "code_probe_failed",
      `The workspace host could not run code serve-web --help (exit ${help.exitCode}). Run it on that host with DONT_PROMPT_WSL_INSTALL=1 to check launcher prompts, permissions, and runtime dependencies.`,
    );
  }
  if (!["--connection-token-file", "--default-folder", "--port"].every((flag) => help.stdout.includes(flag))) {
    throw new DomainError("code_unsupported", "The workspace host's code CLI does not advertise the required serve-web options: --connection-token-file, --default-folder, and --port. Use a VS Code CLI that supports serve-web, not an editor launcher.");
  }
  const bash = await executor.exec("bash", ["--version"], { cwd: directory, timeout: 5_000, signal, logFailures: false });
  if (!bash.success) {
    throw new DomainError("code_runtime_unavailable", "VS Code sessions require bash on workspace hosts for process-tree cleanup.");
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
    "bash",
    ["-c", CODE_PROCESS_WRAPPER, "clanky-code", "code", ...options.args],
    {
      cwd: options.directory, timeout: null, signal: options.signal,
      env: { ...CODE_ENV, CLANKY_CODE_PID_FILE: options.pidPath, CLANKY_CODE_CLEANUP_FILE: options.cleanupPath },
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
  if (run) {
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
    if (!stopped && result?.termination === "failed") {
      throw new DomainError("code_cleanup_failed", "VS Code process-tree cleanup could not be confirmed.");
    }
  } catch (error) {
    const confirmedCancellation = isDomainError(error)
      && error.code === "mesh_execution_aborted"
      && (stopped || error.details["terminationConfirmed"] === true);
    if (!stopped && !(controller.signal.aborted && confirmedCancellation)) {
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function startCodeServer(options: {
  id: string;
  persistOwnership: (ownership: CodePreviewCleanup | undefined) => Promise<void>;
  executor: CommandExecutor;
  directory: string;
  signal: AbortSignal;
}): Promise<CodeServer> {
  const { executor, directory, signal } = options;
  signal.throwIfAborted();
  await assertCodeAvailable(executor, directory, signal);
  const ownership = await prepareCodeSession({
    executor, directory, id: options.id, persist: options.persistOwnership,
  });
  const temporaryDirectory = ownership.temporaryDirectory;
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
      await cleanupCodeSession({ executor, id: options.id, ownership });
    } finally {
      controller.abort();
      signal.removeEventListener("abort", abort);
    }
  })().catch((error) => {
    closing = undefined;
    throw error;
  });

  try {
    if (!(await executor.writeFile(tokenPath, token))) {
      throw new DomainError("code_start_failed", "Unable to write the VS Code session credential.");
    }
    if (!(await executor.writeFile(cleanupPath, CODE_PROCESS_CLEANUP))) {
      throw new DomainError("code_start_failed", "Unable to write the VS Code process cleanup script.");
    }
    const cleanupCheck = await executor.exec("bash", [cleanupPath, pidPath], {
      cwd: directory, timeout: 5_000, signal: controller.signal, logFailures: false,
    });
    if (!cleanupCheck.success) {
      throw new DomainError("code_runtime_unavailable", `VS Code sessions require process inspection with bash, ps, awk, and sort on this workspace host (exit ${cleanupCheck.exitCode}).`);
    }
    controller.signal.throwIfAborted();
    const args = [
      "serve-web", "--host", "127.0.0.1", "--port", "0",
      "--connection-token-file", tokenPath,
      "--server-data-dir", paths.join(temporaryDirectory, "server"),
      "--default-folder", directory, "--log", "warn",
      "--accept-server-license-terms",
    ];
    const launched = launchCodeProcess({ executor, directory, args, pidPath, cleanupPath, signal: controller.signal });
    run = launched.run;
    // The owner handles every exit identically; close still awaits the original outcome.
    const exited = run.then(() => undefined, () => undefined);
    const port = await Promise.race([
      launched.listening,
      run.then((result) => {
        throw new DomainError(
          "code_start_failed",
          `VS Code stopped before its web listener was ready (exit ${result.exitCode}). Check the workspace host's VS Code runtime dependencies and network access for server downloads. Server license terms are accepted automatically.`,
        );
      }),
    ]);
    return { port, directory, token, exited, close };
  } catch (error) {
    try {
      await close();
      await options.persistOwnership(undefined);
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
