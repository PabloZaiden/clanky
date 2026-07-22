/**
 * Runs deterministic agent code on the selected workspace host.
 *
 * The host-side runner is a small Node.js program. It starts the user module
 * in a child process and uses IPC for context requests and explicit output.
 * This keeps arbitrary user stdout/stderr away from the control protocol and
 * makes only ctx.stdout.write()/ctx.stderr.write() visible to Clanky.
 */

import type { AgentRun } from "@/shared/agent";
import type { CommandExecutor } from "./command-executor";
import type { DeterministicAgentOutput } from "./deterministic-agent-output";
import type { ManagedRuntimeCredential } from "./managed-credential-service";
import { createLogger } from "@pablozaiden/webapp/server";

const log = createLogger("deterministic-agent-runner");

/** Minimum Node.js major version required on the workspace host. */
const MIN_NODE_MAJOR_VERSION = 24;
const RUNNER_CLEANUP_TIMEOUT_MS = 10_000;
const HOST_TEMP_DIRECTORY_PATTERN = /^\/tmp\/clanky-agent\.[A-Za-z0-9_-]+$/;

/** Runner control-message types emitted by the workspace-side Node.js process. */
export type RunnerMessage =
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "aborted" };

// ---------------------------------------------------------------------------
// Runner script — embedded as a string and written to the workspace host.
// ---------------------------------------------------------------------------

/**
 * Plain Node.js 24+ ESM runner.
 *
 * The controller process owns the managed credential and handles workspace
 * exec/prompt requests. User code runs in a forked worker with those secrets
 * removed from its environment. The worker's direct stdout/stderr are drained
 * and intentionally ignored; only explicit context output is forwarded.
 */
export const DETERMINISTIC_AGENT_RUNNER_SCRIPT = `
// Clanky deterministic agent runner — Node.js 24+
// This generated file is executed on the workspace host.
import { execFile } from "node:child_process";
import { fork } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const CONTROL_MODE = process.argv[2] !== "--worker";
const codeFilePath = CONTROL_MODE ? process.argv[2] : process.argv[3];
const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_EXPLICIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_EXPLICIT_OUTPUT_CHUNK = 16 * 1024;
const MAX_PENDING_OUTPUT_BYTES = 256 * 1024;

function sendControl(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function sendIpc(message) {
  if (typeof process.send !== "function") {
    return Promise.reject(new Error("Runner worker IPC is unavailable"));
  }
  return new Promise((resolve, reject) => {
    process.send(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function errorMessage(error) {
  return error && typeof error.message === "string" ? error.message : String(error);
}

async function sendResponse(id, response) {
  try {
    await sendIpc({ type: "response", id, ...response });
  } catch {
    // The worker may have exited while a request was being completed.
  }
}

async function executeWorkspaceCommand(message, signal) {
  const command = typeof message.command === "string" ? message.command : "";
  const args = Array.isArray(message.args)
    ? message.args.filter((arg) => typeof arg === "string")
    : [];
  const options = isRecord(message.options) ? message.options : {};
  if (!command) {
    return {
      success: false,
      stdout: "",
      stderr: "workspace.exec requires a command",
      exitCode: 2,
    };
  }
  if (signal.aborted) {
    return { success: false, stdout: "", stderr: "Aborted", exitCode: 130 };
  }

  try {
    const result = await execFileAsync(command, args, {
      cwd: typeof options.cwd === "string" ? options.cwd : process.cwd(),
      timeout: typeof options.timeout === "number" ? options.timeout : undefined,
      maxBuffer: MAX_BUFFER,
      signal,
      env: { ...process.env },
    });
    return {
      success: true,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
    };
  } catch (error) {
    if (signal.aborted || (isRecord(error) && error.name === "AbortError")) {
      return {
        success: false,
        stdout: isRecord(error) && typeof error.stdout === "string" ? error.stdout : "",
        stderr: "Aborted",
        exitCode: 130,
      };
    }
    return {
      success: false,
      stdout: isRecord(error) && typeof error.stdout === "string" ? error.stdout : "",
      stderr: isRecord(error) && typeof error.stderr === "string"
        ? error.stderr
        : errorMessage(error),
      exitCode: isRecord(error) && typeof error.code === "number" ? error.code : 1,
    };
  }
}

async function executeWorkspacePrompt(message, signal) {
  const baseUrl = process.env["CLANKY_BASE_URL"] || "";
  const apiKey = process.env["CLANKY_API_KEY"] || "";
  const chatId = process.env["CLANKY_CHAT_ID"] || "";
  if (!baseUrl || !apiKey || !chatId) {
    throw new Error(
      "ctx.workspace.prompt is not available: workspace context credentials are not configured for this run",
    );
  }
  if (signal.aborted) {
    throw new Error("Aborted");
  }

  const response = await fetch(baseUrl + "/api/internal/agent-prompt", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey,
    },
    body: JSON.stringify({
      chatId,
      message: typeof message.message === "string" ? message.message : "",
    }),
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      "Prompt request failed (" + response.status + "): " + (body || response.statusText),
    );
  }
  const data = await response.json();
  if (!isRecord(data) || typeof data.response !== "string") {
    throw new Error("Prompt bridge returned an invalid response");
  }
  return data.response;
}

async function runWorker() {
  const abortController = new AbortController();
  const pending = new Map();
  let requestId = 0;
  const outputQueue = [];
  let outputQueueBytes = 0;
  let outputDrainPromise;
  let outputBytes = 0;

  process.on("message", (message) => {
    if (!isRecord(message)) return;
    if (message.type === "abort") {
      abortController.abort();
      return;
    }
    if (message.type !== "response" || typeof message.id !== "number") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.ok) request.resolve(message.value);
    else request.reject(new Error(typeof message.error === "string" ? message.error : "Runner request failed"));
  });
  process.on("disconnect", () => abortController.abort());

  const request = (action, payload) => {
    if (abortController.signal.aborted) {
      return Promise.reject(new Error("Aborted"));
    }
    if (pending.size >= 128) {
      return Promise.reject(new Error("Too many concurrent workspace context requests"));
    }
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      void sendIpc({ type: "request", id, action, ...payload }).catch((error) => {
        pending.delete(id);
        reject(error);
      });
    });
  };

  const drainOutputQueue = () => {
    if (outputDrainPromise) return outputDrainPromise;
    outputDrainPromise = (async () => {
      try {
        while (outputQueue.length > 0) {
          const item = outputQueue.shift();
          if (!item) continue;
          outputQueueBytes -= item.text.length;
          await sendIpc({ type: "output", stream: item.stream, text: item.text });
        }
      } catch {
        // The controller owns the output pipe and may exit during cancellation.
        outputQueue.length = 0;
        outputQueueBytes = 0;
      }
    })().finally(() => {
      outputDrainPromise = undefined;
    });
    return outputDrainPromise;
  };

  const sendOutput = (type, text) => {
    if (typeof text !== "string" || text.length === 0 || outputBytes >= MAX_EXPLICIT_OUTPUT_BYTES) {
      return;
    }
    const remainingBytes = MAX_EXPLICIT_OUTPUT_BYTES - outputBytes;
    const remainingQueueBytes = MAX_PENDING_OUTPUT_BYTES - outputQueueBytes;
    const chunkLength = Math.min(
      text.length,
      MAX_EXPLICIT_OUTPUT_CHUNK,
      remainingBytes,
      remainingQueueBytes,
    );
    if (chunkLength <= 0) {
      return;
    }
    const chunk = text.slice(0, chunkLength);
    outputBytes += chunk.length;
    outputQueueBytes += chunk.length;
    outputQueue.push({ stream: type, text: chunk });
    void drainOutputQueue();
  };

  const context = {
    workspace: {
      async exec(command, args, options) {
        return await request("exec", {
          command,
          args: args ?? [],
          options: options ?? {},
        });
      },
      async prompt(message) {
        return await request("prompt", { message });
      },
    },
    stdout: {
      write(text) {
        sendOutput("stdout", String(text));
      },
    },
    stderr: {
      write(text) {
        sendOutput("stderr", String(text));
      },
    },
    signal: abortController.signal,
  };

  try {
    if (!codeFilePath) {
      throw new Error("No user code file path specified");
    }
    const moduleUrl = pathToFileURL(codeFilePath).href;
    const module = await import(moduleUrl);
    if (typeof module.default !== "function") {
      throw new Error("User code must export a default function");
    }
    await module.default(context);
    await drainOutputQueue();
    if (abortController.signal.aborted) {
      await sendIpc({ type: "aborted" });
    } else {
      await sendIpc({ type: "done" });
    }
  } catch (error) {
    await drainOutputQueue();
    if (abortController.signal.aborted) {
      await sendIpc({ type: "aborted" });
    } else {
      await sendIpc({ type: "error", message: errorMessage(error) });
    }
    process.exitCode = 1;
  } finally {
    if (process.connected) {
      process.disconnect();
    }
  }
}

async function runController() {
  if (!codeFilePath) {
    sendControl({ type: "error", message: "No user code file path specified" });
    process.exitCode = 1;
    return;
  }

  const abortController = new AbortController();
  let terminalMessageSeen = false;
  let workerExitCode = 1;
  let workerStderr = "";
  let abortTimer;
  let promptQueue = Promise.resolve();

  const workerEnv = { ...process.env };
  delete workerEnv["CLANKY_BASE_URL"];
  delete workerEnv["CLANKY_API_KEY"];
  delete workerEnv["CLANKY_CHAT_ID"];

  const worker = fork(new URL(import.meta.url), ["--worker", codeFilePath], {
    env: workerEnv,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  const sendWorker = (message) => {
    if (!worker.connected) return;
    worker.send(message, () => {});
  };

  const finishWithError = (message) => {
    if (terminalMessageSeen) return;
    terminalMessageSeen = true;
    sendControl({ type: "error", message });
  };
  const executePromptSerially = (message) => {
    const current = promptQueue.then(() => executeWorkspacePrompt(message, abortController.signal));
    promptQueue = current.then(() => undefined, () => undefined);
    return current;
  };

  worker.stdout?.on("data", () => {
    // Direct process.stdout/console output from user code is intentionally not
    // part of the deterministic output contract.
  });
  worker.stderr?.on("data", (chunk) => {
    if (workerStderr.length < 16 * 1024) {
      workerStderr += String(chunk).slice(0, 16 * 1024 - workerStderr.length);
    }
  });
  worker.on("message", (message) => {
    if (!isRecord(message)) return;
    if (message.type === "output") {
      if (message.stream === "stdout" || message.stream === "stderr") {
        sendControl({ type: message.stream, text: String(message.text ?? "") });
      }
      return;
    }
    if (message.type === "done") {
      terminalMessageSeen = true;
      sendControl({ type: "done" });
      return;
    }
    if (message.type === "aborted") {
      terminalMessageSeen = true;
      sendControl({ type: "aborted" });
      return;
    }
    if (message.type === "error") {
      finishWithError(typeof message.message === "string" ? message.message : "Deterministic agent failed");
      return;
    }
    if (message.type !== "request" || typeof message.id !== "number") return;

    const operation = message.action === "prompt"
      ? executePromptSerially(message)
      : message.action === "exec"
        ? executeWorkspaceCommand(message, abortController.signal)
        : Promise.reject(new Error("Unknown runner request"));
    void operation.then(
      (value) => sendWorker({ type: "response", id: message.id, ok: true, value }),
      (error) => sendWorker({
        type: "response",
        id: message.id,
        ok: false,
        error: errorMessage(error),
      }),
    );
  });
  worker.on("error", (error) => {
    finishWithError(errorMessage(error));
  });

  const onAbort = () => {
    abortController.abort();
    sendWorker({ type: "abort" });
    abortTimer = setTimeout(() => {
      try {
        worker.kill("SIGTERM");
      } catch {
        // The worker may already have exited.
      }
    }, 2000);
  };
  process.on("SIGTERM", onAbort);
  process.on("SIGINT", onAbort);

  workerExitCode = await new Promise((resolve) => {
    worker.on("close", (code) => resolve(typeof code === "number" ? code : 1));
  });
  if (abortTimer) clearTimeout(abortTimer);
  process.off("SIGTERM", onAbort);
  process.off("SIGINT", onAbort);

  if (abortController.signal.aborted) {
    if (!terminalMessageSeen) sendControl({ type: "aborted" });
    return;
  }
  if (!terminalMessageSeen) {
    finishWithError(workerStderr.trim() || "Deterministic agent worker exited unexpectedly");
  }
  if (workerExitCode !== 0) {
    process.exitCode = 1;
  }
}

if (CONTROL_MODE) {
  await runController();
} else {
  await runWorker();
}
`;

// ---------------------------------------------------------------------------
// Node.js version validation
// ---------------------------------------------------------------------------

/**
 * Verify that the workspace host has Node.js >= MIN_NODE_MAJOR_VERSION.
 * Throws if Node.js is absent or too old.
 */
export async function assertNodeVersionOnHost(executor: CommandExecutor): Promise<void> {
  const result = await executor.exec("node", ["--version"], { logFailures: false });
  if (!result.success) {
    throw new Error(
      `Node.js ${MIN_NODE_MAJOR_VERSION} or newer is required on the workspace host, but 'node --version' failed: ${result.stderr || result.stdout || `exit code ${result.exitCode}`}`,
    );
  }
  const raw = result.stdout.trim();
  const match = raw.match(/^v(\d+)\./);
  const major = match?.[1] ? parseInt(match[1], 10) : 0;
  if (major < MIN_NODE_MAJOR_VERSION) {
    throw new Error(
      `Node.js ${MIN_NODE_MAJOR_VERSION} or newer is required on the workspace host (found ${raw})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Runner launch
// ---------------------------------------------------------------------------

export interface LaunchRunnerOptions {
  run: AgentRun;
  /** TypeScript source for the user module, executed by Node.js type stripping. */
  sourceCode: string;
  chatId: string;
  credential?: ManagedRuntimeCredential;
  directory: string;
  signal: AbortSignal;
  output: DeterministicAgentOutput;
  executor: CommandExecutor;
}

async function createHostTempDirectory(
  executor: CommandExecutor,
  directory: string,
  signal: AbortSignal,
): Promise<string> {
  const result = await executor.exec(
    "mktemp",
    ["-d", "/tmp/clanky-agent.XXXXXX"],
    {
      cwd: directory,
      timeout: RUNNER_CLEANUP_TIMEOUT_MS,
      logFailures: false,
      signal,
    },
  );
  if (!result.success) {
    throw new Error(
      `Failed to create runner temp directory on workspace host: ${result.stderr || result.stdout || result.exitCode}`,
    );
  }

  const tempDir = result.stdout.trim();
  if (!HOST_TEMP_DIRECTORY_PATTERN.test(tempDir)) {
    throw new Error("Workspace host returned an invalid deterministic runner temp directory");
  }

  try {
    const chmodResult = await executor.exec(
      "chmod",
      ["700", "--", tempDir],
      {
        cwd: directory,
        timeout: RUNNER_CLEANUP_TIMEOUT_MS,
        logFailures: false,
        signal,
      },
    );
    if (!chmodResult.success) {
      throw new Error(
        `Failed to secure runner temp directory on workspace host: ${chmodResult.stderr || chmodResult.stdout || chmodResult.exitCode}`,
      );
    }
  } catch (error) {
    try {
      const cleanupResult = await executor.exec("rm", ["-rf", "--", tempDir], {
        cwd: directory,
        timeout: RUNNER_CLEANUP_TIMEOUT_MS,
        logFailures: false,
      });
      if (!cleanupResult.success) {
        throw new Error(
          cleanupResult.stderr || cleanupResult.stdout || `exit code ${cleanupResult.exitCode}`,
        );
      }
    } catch (cleanupError) {
      log.error("Failed to clean up deterministic runner directory after setup failure", {
        tempDir,
        error: String(cleanupError),
      });
      throw new AggregateError(
        [error, cleanupError],
        "Deterministic agent runner setup and workspace cleanup failed",
      );
    }
    throw error;
  }
  return tempDir;
}

/**
 * Writes the runner and user code to a temporary directory on the workspace
 * host, launches Node.js without an execution timeout, and streams only the
 * explicit program output from the control protocol.
 */
export async function launchDeterministicAgentOnHost(
  options: LaunchRunnerOptions,
): Promise<AgentRun> {
  const {
    run,
    sourceCode,
    chatId,
    credential,
    directory,
    signal,
    output,
    executor,
  } = options;

  let tempDir: string | undefined;
  let executionError: unknown;
  try {
    tempDir = await createHostTempDirectory(executor, directory, signal);
    const runnerPath = `${tempDir}/runner.mjs`;
    const codePath = `${tempDir}/code.ts`;

    const [runnerOk, codeOk] = await Promise.all([
      executor.writeFile(runnerPath, DETERMINISTIC_AGENT_RUNNER_SCRIPT),
      executor.writeFile(codePath, sourceCode),
    ]);
    if (!runnerOk) {
      throw new Error("Failed to write runner script to workspace host");
    }
    if (!codeOk) {
      throw new Error("Failed to write user code to workspace host");
    }

    const runEnv: Record<string, string> = credential
      ? {
          CLANKY_BASE_URL: credential.baseUrl,
          CLANKY_API_KEY: credential.token,
          CLANKY_CHAT_ID: chatId,
        }
      : {};

    let lineBuffer = "";
    let runnerError: string | undefined;
    let runnerAborted = false;

    const handleChunk = (chunk: string): void => {
      lineBuffer += chunk;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let message: RunnerMessage;
        try {
          message = JSON.parse(trimmed) as RunnerMessage;
        } catch {
          log.debug("Ignoring malformed runner control line", { runId: run.id });
          continue;
        }
        switch (message.type) {
          case "stdout":
            output.append("stdout", message.text);
            break;
          case "stderr":
            output.append("stderr", message.text);
            break;
          case "error":
            runnerError = message.message;
            break;
          case "aborted":
            runnerAborted = true;
            break;
          case "done":
            break;
        }
      }
    };

    const execResult = await executor.exec(
      "node",
      [runnerPath, codePath],
      {
        cwd: directory,
        env: runEnv,
        signal,
        timeout: null,
        logFailures: false,
        onStdoutChunk: handleChunk,
      },
    );

    if (lineBuffer.trim()) {
      try {
        handleChunk(`${lineBuffer.trim()}\n`);
      } catch {
        // Ignore an incomplete trailing protocol line after process exit.
      }
    }

    if (signal.aborted || runnerAborted) {
      throw Object.assign(new Error("Deterministic agent run interrupted"), { cause: "aborted" });
    }
    if (runnerError) {
      throw new Error(runnerError);
    }
    if (!execResult.success) {
      const detail = execResult.stderr?.trim()
        || execResult.stdout?.trim()
        || `exit code ${execResult.exitCode}`;
      throw new Error(`Runner process failed: ${detail}`);
    }
    return output.run;
  } catch (error) {
    executionError = error;
    throw error;
  } finally {
    if (tempDir) {
      try {
        const cleanupResult = await executor.exec("rm", ["-rf", "--", tempDir], {
          logFailures: false,
          timeout: RUNNER_CLEANUP_TIMEOUT_MS,
        });
        if (!cleanupResult.success) {
          throw new Error(
            cleanupResult.stderr || cleanupResult.stdout || `exit code ${cleanupResult.exitCode}`,
          );
        }
      } catch (cleanupError) {
        log.error("Failed to clean up deterministic agent runner directory", {
          runId: run.id,
          tempDir,
          error: String(cleanupError),
        });
        if (executionError !== undefined) {
          throw new AggregateError(
            [executionError, cleanupError],
            "Deterministic agent execution and workspace cleanup failed",
          );
        }
        throw cleanupError;
      }
    }
  }
}
