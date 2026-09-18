/**
 * CommandExecutorImpl — executes commands either locally or over SSH.
 * Local commands are queued to ensure only one runs at a time per executor
 * instance. SSH commands let the first real command initialize ControlMaster,
 * while concurrent commands wait for that first command and then run in
 * parallel over the shared multiplexed connection.
 */

import { posix, win32 } from "node:path";
import type {
  CommandExecutor,
  CommandResult,
  CommandOptions,
  FileDeleteOptions,
  FileMoveOptions,
  FileMoveResult,
  FileStreamOptions,
  FileSystemDirectoryEntry,
  FileSystemMetadata,
  FileWriteStreamOptions,
  FileWriteStreamResult,
  GitCommandOptions,
  GitEnvironmentVariableName,
} from "../command-executor";
import { CommandOutputLimitError } from "../command-executor";
import { log } from "@pablozaiden/webapp/server";
import type { CommandExecutorConfig } from "./types";
import { quoteShell, buildEnvAssignments, readProcessStream } from "./utils";
import { buildSshRemoteShellCommand, buildSshCommandArgs } from "./ssh-helpers";
import { LocalFileSystem } from "./local-filesystem";
import {
  normalizeExecutionRoot,
  resolveExecutionPathUnscoped,
  type ExecutionPathStyle,
} from "../execution-path";
import type { AgentProvider } from "@/shared/settings";
import {
  buildProviderAvailabilityShellCheck,
  isAgentProviderAvailable,
} from "../agent-runtime-command";
import { terminateSubprocessTree } from "../subprocess-termination";

const LOG_PREFIX = "[CommandExecutor]";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const POSIX_DEFAULT_PATH =
  "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin";

const sshControlMasterInitializers = new Map<string, Promise<CommandResult>>();

function inheritedExecutableSearchPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const configured = platform === "win32"
    ? Object.entries(environment).find(([key]) => key.toLowerCase() === "path")?.[1]
    : environment["PATH"];
  if (configured?.trim()) {
    return configured;
  }
  if (platform !== "win32") {
    return POSIX_DEFAULT_PATH;
  }
  const windowsDirectory = environment["SystemRoot"] ?? environment["WINDIR"];
  if (!windowsDirectory?.trim()) {
    return undefined;
  }
  return [
    win32.join(windowsDirectory, "System32"),
    windowsDirectory,
    win32.join(windowsDirectory, "System32", "Wbem"),
    win32.join(
      windowsDirectory,
      "System32",
      "WindowsPowerShell",
      "v1.0",
    ),
  ].join(";");
}
export interface StreamedProcess {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill: () => void;
}

function createErroredStream(error: Error): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller: ReadableStreamDefaultController<Uint8Array>) {
      controller.error(error);
    },
  });
}

export function createProcessStdoutStream(
  proc: StreamedProcess,
  label: string,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const stdout = proc.stdout;
  if (!stdout) {
    try {
      proc.kill();
    } catch {
      // Ignore cleanup errors when the process failed to expose stdout.
    }
    return createErroredStream(new Error(`${label} did not expose stdout`));
  }

  const stderrPromise = readProcessStream(proc.stderr);
  let cancelled = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let abortHandler: (() => void) | undefined;
  let resolveCancelled: (() => void) | undefined;
  const cancelledPromise = new Promise<"cancelled">((resolve) => {
    resolveCancelled = () => resolve("cancelled");
  });

  const markCancelled = () => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    resolveCancelled?.();
  };

  const killProcess = () => {
    try {
      proc.kill();
    } catch {
      // Ignore cleanup errors while cancelling a stream.
    }
  };

  const processCompletionPromise = Promise.all([proc.exited, stderrPromise])
    .then(([exitCode, stderr]) => ({
      type: "completed" as const,
      exitCode,
      stderr,
    }))
    .catch((error) => ({
      type: "error" as const,
      error,
    }));

  const cleanup = () => {
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
      abortHandler = undefined;
    }
  };
  let finished = false;
  const finish = () => {
    if (finished) return;
    try {
      reader?.releaseLock();
    } catch {
      // The reader may still be locked while cancellation is being delivered.
    }
    finished = true;
    cleanup();
  };

  return new ReadableStream<Uint8Array>({
    start() {
      const stdoutReader = stdout.getReader();
      reader = stdoutReader;
      abortHandler = () => {
        markCancelled();
        void stdoutReader.cancel().catch(() => undefined);
        killProcess();
      };

      if (signal?.aborted) {
        abortHandler();
        return;
      }
      signal?.addEventListener("abort", abortHandler, { once: true });
    },
    async pull(controller: ReadableStreamDefaultController<Uint8Array>) {
      if (!reader) {
        controller.error(new Error(`${label} stream reader is unavailable`));
        finish();
        return;
      }

      try {
        const { done, value } = await reader.read();
        if (done) {
          if (cancelled) {
            controller.close();
            finish();
            return;
          }
          const processResult = await Promise.race([
            processCompletionPromise,
            cancelledPromise,
          ]);
          if (processResult === "cancelled" || cancelled) {
            controller.close();
            finish();
            return;
          }
          if (processResult.type === "error") {
            controller.error(
              processResult.error instanceof Error
                ? processResult.error
                : new Error(String(processResult.error)),
            );
            finish();
            return;
          }
          if (processResult.exitCode !== 0) {
            controller.error(
              new Error(processResult.stderr.trim() || `${label} failed with exit code ${processResult.exitCode}`),
            );
            finish();
            return;
          }
          controller.close();
          finish();
          return;
        }
        if (!cancelled) {
          controller.enqueue(value);
        }
      } catch (error) {
        if (!cancelled) {
          controller.error(error instanceof Error ? error : new Error(String(error)));
        }
        finish();
      }
    },
    async cancel() {
      markCancelled();
      try {
        await reader?.cancel();
      } finally {
        finish();
        killProcess();
      }
    },
  });
}

export class CommandExecutorImpl implements CommandExecutor {
  readonly pathStyle: ExecutionPathStyle;
  private readonly provider: "local" | "ssh";
  private readonly directory: string;
  private readonly host?: string;
  private readonly port: number;
  private readonly user?: string;
  private readonly password?: string;
  private readonly identityFile?: string;
  private readonly defaultTimeoutMs: number;
  private readonly localFileSystem: LocalFileSystem | null;
  private executionDirectoryPromise: Promise<string> | undefined;

  /** Queue of pending commands */
  private commandQueue: Array<{
    execute: () => Promise<CommandResult>;
    resolve: (result: CommandResult) => void;
    reject: (error: Error) => void;
  }> = [];

  /** Whether a command is currently executing */
  private isExecuting = false;

  constructor(config: CommandExecutorConfig) {
    this.provider = config.provider ?? "local";
    this.localFileSystem = this.provider === "local"
      ? new LocalFileSystem()
      : null;
    this.pathStyle = this.localFileSystem?.pathStyle ?? "posix";
    this.directory = config.directory;
    this.host = config.host;
    this.port = config.port ?? 22;
    this.user = config.user;
    this.password = config.password;
    this.identityFile = config.identityFile?.trim() || undefined;
    this.defaultTimeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getExecutionDirectory(): Promise<string> {
    const pending = this.executionDirectoryPromise
      ??= this.resolveExecutionDirectory();
    try {
      return await pending;
    } catch (error) {
      if (this.executionDirectoryPromise === pending) {
        this.executionDirectoryPromise = undefined;
      }
      throw error;
    }
  }

  private async resolveExecutionDirectory(): Promise<string> {
    if (this.provider === "local") {
      return resolveExecutionPathUnscoped(
        process.cwd(),
        this.directory,
        this.pathStyle,
      );
    }

    const result = await this.exec("pwd", ["-P"], {
      logFailures: false,
    });
    if (!result.success || !result.stdout.trim()) {
      throw new Error(
        `Failed to resolve the SSH execution directory: ${
          result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`
        }`,
      );
    }
    return normalizeExecutionRoot(result.stdout.trim(), this.pathStyle);
  }

  async getEnvironmentVariable(name: string): Promise<string | null> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }
    if (this.provider === "local") {
      return process.env[name] ?? null;
    }

    const result = await this.exec("printenv", [name], {
      logFailures: false,
    });
    return result.success ? result.stdout.trim() || null : null;
  }

  async getGitEnvironmentVariable(
    name: GitEnvironmentVariableName,
  ): Promise<string | null> {
    return await this.getEnvironmentVariable(name);
  }

  async execGit(
    directory: string,
    args: string[],
    options: GitCommandOptions,
  ): Promise<CommandResult> {
    return await this.exec("git", ["-C", directory, ...args], options);
  }

  async isAgentProviderAvailable(provider: AgentProvider): Promise<boolean> {
    if (this.provider === "local") {
      return isAgentProviderAvailable(provider);
    }
    return (await this.exec(
      "sh",
      ["-lc", buildProviderAvailabilityShellCheck(provider)],
      { cwd: "/", logFailures: false },
    )).success;
  }

  /**
   * Execute a shell command.
   */
  async exec(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
    const cmdStr = `${command} ${args.join(" ")}`;
    const executeCommand = async (): Promise<CommandResult> => {
      const cwd = options?.cwd ?? this.directory;
      const timeout = options?.timeout === null
        ? undefined
        : options?.timeout ?? this.defaultTimeoutMs;
      const env = options?.env;
      const signal = options?.signal;
      const onStdoutChunk = options?.onStdoutChunk;
      const onStderrChunk = options?.onStderrChunk;
      const maxOutputBytes = options?.maxOutputBytes;
      const result = this.provider === "ssh"
        ? await this.execSsh(
          command,
          args,
          cwd,
          timeout,
          env,
          signal,
          onStdoutChunk,
          onStderrChunk,
          maxOutputBytes,
        )
        : await this.execLocal(
          command,
          args,
          cwd,
          timeout,
          env,
          signal,
          onStdoutChunk,
          onStderrChunk,
          maxOutputBytes,
        );

      if (!result.success && options?.logFailures !== false) {
        log.error(`${LOG_PREFIX} Command failed: ${cmdStr}`);
        log.error(`${LOG_PREFIX}   exitCode: ${result.exitCode}`);
        if (result.stderr) {
          log.error(`${LOG_PREFIX}   stderr: ${result.stderr}`);
        }
      }
      return result;
    };

    if (this.provider === "ssh") {
      return await executeCommand();
    }

    return new Promise<CommandResult>((resolve, reject) => {
      this.commandQueue.push({ execute: executeCommand, resolve, reject });
      void this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isExecuting) {
      return;
    }
    this.isExecuting = true;

    while (this.commandQueue.length > 0) {
      const item = this.commandQueue.shift();
      if (!item) break;
      try {
        const result = await item.execute();
        item.resolve(result);
      } catch (error) {
        item.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    this.isExecuting = false;
  }

  private async execLocal(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number | undefined,
    env?: Record<string, string>,
    signal?: AbortSignal,
    onStdoutChunk?: (chunk: string) => void,
    onStderrChunk?: (chunk: string) => void,
    maxOutputBytes?: number,
  ): Promise<CommandResult> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;
    try {
      if (signal?.aborted) {
        return {
          success: false,
          stdout: "",
          stderr: "Command aborted",
          exitCode: 130,
        };
      }

      const executableSearchPath = inheritedExecutableSearchPath();
      const commandEnv = {
        ...process.env,
        ...(executableSearchPath ? { PATH: executableSearchPath } : {}),
        ...env,
      };

      const subprocess = Bun.spawn([command, ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: commandEnv,
      });
      let terminationPromise: Promise<void> | undefined;
      const terminateProcess = (): Promise<void> => {
        terminationPromise ??= terminateSubprocessTree(subprocess, {
          requireExit: true,
        });
        return terminationPromise;
      };
      const requestTermination = (): void => {
        void terminateProcess().catch(() => {
          // The owning execution path awaits and reports this failure.
        });
      };
      let outputLimitError: CommandOutputLimitError | undefined;
      let resolveOutputLimit: ((exitCode: number) => void) | undefined;
      const outputLimitPromise = maxOutputBytes === undefined
        ? undefined
        : new Promise<number>((resolve) => {
            resolveOutputLimit = resolve;
          });
      const handleOutputLimit = (error: CommandOutputLimitError): void => {
        outputLimitError ??= error;
        requestTermination();
        resolveOutputLimit?.(1);
      };
      const stdoutPromise = readProcessStream(subprocess.stdout, onStdoutChunk, {
        maxBytes: maxOutputBytes,
        streamName: "stdout",
        onLimit: handleOutputLimit,
      });
      const stderrPromise = readProcessStream(subprocess.stderr, onStderrChunk, {
        maxBytes: maxOutputBytes,
        streamName: "stderr",
        onLimit: handleOutputLimit,
      });
      const streamResultsPromise = Promise.allSettled([
        stdoutPromise,
        stderrPromise,
      ]);

      let timedOut = false;
      let aborted = false;
      const timeoutPromise = timeoutMs === undefined
        ? undefined
        : new Promise<number>((resolve) => {
            timeoutId = setTimeout(() => {
              timedOut = true;
              requestTermination();
              resolve(124);
            }, timeoutMs);
          });

      const abortPromise = new Promise<number>((resolve) => {
        if (!signal) {
          return;
        }

        if (signal.aborted) {
          aborted = true;
          requestTermination();
          resolve(130);
          return;
        }

        abortHandler = () => {
          aborted = true;
          requestTermination();
          resolve(130);
        };

        signal.addEventListener("abort", abortHandler, { once: true });
      });

      const racePromises: Promise<number>[] = [subprocess.exited];
      if (timeoutPromise) {
        racePromises.push(timeoutPromise);
      }
      if (signal) {
        racePromises.push(abortPromise);
      }
      if (outputLimitPromise) {
        racePromises.push(outputLimitPromise);
      }
      const racedExitCode = await Promise.race(racePromises);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
      let terminationFailed = false;
      let terminationFailure: unknown;
      const waitForTermination = async (reason: string): Promise<void> => {
        if (!terminationPromise || terminationFailed) {
          return;
        }
        try {
          await terminationPromise;
        } catch (error) {
          terminationFailed = true;
          terminationFailure = error;
          log.error(`${LOG_PREFIX} Failed to terminate subprocess tree`, {
            pid: subprocess.pid,
            reason,
            error: String(error),
          });
        }
      };
      if (timedOut || aborted || outputLimitError) {
        await waitForTermination(
          outputLimitError ? "output_limit" : timedOut ? "timeout" : "abort",
        );
      }
      const throwOutputLimit = (error: CommandOutputLimitError): never => {
        if (terminationFailed) {
          throw new CommandOutputLimitError(error.stream, error.maxBytes, {
            cause: terminationFailure,
          });
        }
        throw error;
      };
      if (outputLimitError) {
        throwOutputLimit(outputLimitError);
      }
      if (terminationFailed) {
        const cleanupMessage =
          `Process-tree cleanup failed: ${String(terminationFailure)}`;
        return timedOut
          ? {
              success: false,
              stdout: "",
              stderr: `Command timed out after ${timeoutMs}ms. ${cleanupMessage}`,
              exitCode: 124,
            }
          : {
              success: false,
              stdout: "",
              stderr: `Command aborted. ${cleanupMessage}`,
              exitCode: 130,
            };
      }

      const streamResults = await streamResultsPromise;
      const outputLimitResult = streamResults.find(
        (result): result is PromiseRejectedResult => (
          result.status === "rejected"
          && result.reason instanceof CommandOutputLimitError
        ),
      );
      if (outputLimitResult) {
        await waitForTermination("output_limit");
        throwOutputLimit(outputLimitResult.reason);
      }
      const streamError = streamResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (streamError) {
        throw streamError.reason;
      }
      const stdout = streamResults[0].status === "fulfilled"
        ? streamResults[0].value
        : "";
      const stderr = streamResults[1].status === "fulfilled"
        ? streamResults[1].value
        : "";

      if (timedOut) {
        return {
          success: false,
          stdout,
          stderr: stderr || `Command timed out after ${timeoutMs}ms`,
          exitCode: 124,
        };
      }

      if (aborted || signal?.aborted) {
        return {
          success: false,
          stdout,
          stderr: stderr || "Command aborted",
          exitCode: 130,
        };
      }

      return {
        success: racedExitCode === 0,
        stdout,
        stderr,
        exitCode: racedExitCode,
      };
    } catch (error) {
      if (error instanceof CommandOutputLimitError) {
        throw error;
      }
      return {
        success: false,
        stdout: "",
        stderr: String(error),
        exitCode: 1,
      };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
  }

  private async execSsh(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number | undefined,
    env?: Record<string, string>,
    signal?: AbortSignal,
    onStdoutChunk?: (chunk: string) => void,
    onStderrChunk?: (chunk: string) => void,
    maxOutputBytes?: number,
  ): Promise<CommandResult> {
    if (!this.host) {
      return {
        success: false,
        stdout: "",
        stderr: "SSH execution requires execution host",
        exitCode: 1,
      };
    }

    let envAssignments: string[];
    try {
      envAssignments = buildEnvAssignments(env);
    } catch (error) {
      return {
        success: false,
        stdout: "",
        stderr: String(error),
        exitCode: 1,
      };
    }

    const remoteCommand = [
      `cd ${quoteShell(cwd)}`,
      "&&",
      ...envAssignments,
      quoteShell(command),
      ...args.map((arg) => quoteShell(arg)),
    ].join(" ");
    const remoteShellCommand = buildSshRemoteShellCommand(remoteCommand);
    const sshTarget = this.user ? `${this.user}@${this.host}` : this.host;

    if (this.password && this.password.trim().length > 0) {
      return await this.execLocal(
        "sshpass",
        [
          "-e",
          "ssh",
          ...buildSshCommandArgs({
            authMode: "password",
            port: this.port,
            target: sshTarget,
            remoteCommand: remoteShellCommand,
            identityFile: this.identityFile,
            connectionScope: this.directory,
          }),
        ],
        "/",
        timeoutMs,
        { SSHPASS: this.password },
        signal,
        onStdoutChunk,
        onStderrChunk,
        maxOutputBytes,
      );
    }

    return await this.execBatchSshWithInitialGate(
      sshTarget,
      remoteShellCommand,
      timeoutMs,
      signal,
      onStdoutChunk,
      onStderrChunk,
      maxOutputBytes,
    );
  }

  private buildSshControlMasterInitializerKey(sshTarget: string): string {
    return JSON.stringify({
      host: this.host,
      port: this.port,
      target: sshTarget,
      identityFile: this.identityFile ?? "",
      connectionScope: this.directory,
    });
  }

  private async execBatchSshWithInitialGate(
    sshTarget: string,
    remoteShellCommand: string,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
    onStdoutChunk?: (chunk: string) => void,
    onStderrChunk?: (chunk: string) => void,
    maxOutputBytes?: number,
  ): Promise<CommandResult> {
    const initializerKey = this.buildSshControlMasterInitializerKey(sshTarget);
    const initializer = sshControlMasterInitializers.get(initializerKey);
    if (initializer) {
      await initializer.catch(() => undefined);
      return await this.execBatchSshCommand(
        sshTarget,
        remoteShellCommand,
        timeoutMs,
        signal,
        onStdoutChunk,
        onStderrChunk,
        maxOutputBytes,
      );
    }

    const currentCommand = this.execBatchSshCommand(
      sshTarget,
      remoteShellCommand,
      timeoutMs,
      signal,
      onStdoutChunk,
      onStderrChunk,
      maxOutputBytes,
    );
    sshControlMasterInitializers.set(initializerKey, currentCommand);
    currentCommand.finally(() => {
      sshControlMasterInitializers.delete(initializerKey);
    });
    return await currentCommand;
  }

  private async execBatchSshCommand(
    sshTarget: string,
    remoteShellCommand: string,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
    onStdoutChunk?: (chunk: string) => void,
    onStderrChunk?: (chunk: string) => void,
    maxOutputBytes?: number,
  ): Promise<CommandResult> {
    return await this.execLocal(
      "ssh",
      buildSshCommandArgs({
        authMode: "batch",
        port: this.port,
        target: sshTarget,
        remoteCommand: remoteShellCommand,
        identityFile: this.identityFile,
        connectionScope: this.directory,
      }),
      "/",
      timeoutMs,
      undefined,
      signal,
      onStdoutChunk,
      onStderrChunk,
      maxOutputBytes,
    );
  }

  async fileExists(path: string): Promise<boolean> {
    if (this.localFileSystem) {
      return await this.localFileSystem.fileExists(path);
    }
    const result = await this.exec("test", ["-f", path]);
    return result.success;
  }

  async directoryExists(path: string): Promise<boolean> {
    if (this.localFileSystem) {
      return await this.localFileSystem.directoryExists(path);
    }
    const result = await this.exec("test", ["-d", path]);
    return result.success;
  }

  async readFile(path: string, options?: FileStreamOptions): Promise<string | null> {
    if (this.localFileSystem) {
      return await this.localFileSystem.readFile(path, options);
    }

    const result = await this.exec("cat", [path], { signal: options?.signal });
    if (!result.success) {
      return null;
    }
    return result.stdout;
  }

  async streamFile(path: string, options?: FileStreamOptions): Promise<ReadableStream<Uint8Array> | null> {
    if (this.localFileSystem) {
      return await this.localFileSystem.streamFile(path, options);
    }

    if (!this.host) {
      return createErroredStream(new Error("SSH file streaming requires execution host"));
    }

    const remoteShellCommand = `cat -- ${quoteShell(path)}`;
    const sshTarget = this.user ? `${this.user}@${this.host}` : this.host;

    const proc = this.password && this.password.trim().length > 0
      ? Bun.spawn([
          "sshpass",
          "-e",
          "ssh",
          ...buildSshCommandArgs({
            authMode: "password",
            port: this.port,
            target: sshTarget,
            remoteCommand: remoteShellCommand,
            identityFile: this.identityFile,
            connectionScope: this.directory,
          }),
        ], {
          cwd: "/",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, SSHPASS: this.password },
        })
      : Bun.spawn([
          "ssh",
          ...buildSshCommandArgs({
            authMode: "batch",
            port: this.port,
            target: sshTarget,
            remoteCommand: remoteShellCommand,
            identityFile: this.identityFile,
            connectionScope: this.directory,
          }),
        ], {
          cwd: "/",
          stdout: "pipe",
          stderr: "pipe",
        });

    return createProcessStdoutStream(proc as StreamedProcess, "SSH file stream", options?.signal);
  }

  async writeFileStream(
    path: string,
    stream: ReadableStream<Uint8Array>,
    options?: FileWriteStreamOptions,
  ): Promise<FileWriteStreamResult> {
    if (this.localFileSystem) {
      return await this.localFileSystem.writeFileStream(path, stream, options);
    }

    if (!this.host) {
      return { success: false, bytesWritten: 0, error: "SSH file streaming requires execution host" };
    }

    const parentDir = posix.dirname(path);
    const expectedOffset = options?.expectedOffset;
    const appendMode = options?.append ? "1" : "0";
    const offsetCheck = expectedOffset === undefined
      ? ""
      : ` current_size=0; if [ -e ${quoteShell(path)} ]; then if stat --version >/dev/null 2>&1; then current_size=$(stat -c '%s' ${quoteShell(path)}); else current_size=$(stat -f '%z' ${quoteShell(path)}); fi; fi; if [ "$current_size" -gt ${expectedOffset} ] && [ "${appendMode}" = "1" ]; then if truncate -s ${expectedOffset} ${quoteShell(path)} 2>/dev/null; then current_size=${expectedOffset}; else printf 'Failed to truncate file to expected offset ${expectedOffset}\\n' >&2; exit 3; fi; fi; if [ "$current_size" -ne ${expectedOffset} ]; then printf 'Expected file offset ${expectedOffset}, found %s\\n' "$current_size" >&2; exit 3; fi;`;
    const writeOperator = options?.append ? ">>" : ">";
    const remoteShellCommand = [
      `mkdir -p ${quoteShell(parentDir)}`,
      "&&",
      offsetCheck,
      `cat ${writeOperator} ${quoteShell(path)}`,
    ].join(" ");
    const sshTarget = this.user ? `${this.user}@${this.host}` : this.host;
    const proc = this.password && this.password.trim().length > 0
      ? Bun.spawn([
          "sshpass",
          "-e",
          "ssh",
          ...buildSshCommandArgs({
            authMode: "password",
            port: this.port,
            target: sshTarget,
            remoteCommand: remoteShellCommand,
            identityFile: this.identityFile,
            connectionScope: this.directory,
          }),
        ], {
          cwd: "/",
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, SSHPASS: this.password },
        })
      : Bun.spawn([
          "ssh",
          ...buildSshCommandArgs({
            authMode: "batch",
            port: this.port,
            target: sshTarget,
            remoteCommand: remoteShellCommand,
            identityFile: this.identityFile,
            connectionScope: this.directory,
          }),
        ], {
          cwd: "/",
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });

    let bytesWritten = 0;
    let sizeLimitExceeded = false;
    const abortHandler = () => {
      try {
        proc.kill();
      } catch {
        // Ignore cleanup errors while aborting a streaming write.
      }
    };

    try {
      if (options?.signal?.aborted) {
        abortHandler();
        return { success: false, bytesWritten: 0, error: "Write aborted" };
      }
      options?.signal?.addEventListener("abort", abortHandler, { once: true });
      const stdin = proc.stdin;
      const reader = stream.getReader();
      try {
        while (true) {
          if (options?.signal?.aborted) {
            abortHandler();
            return { success: false, bytesWritten, error: "Write aborted" };
          }
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (
            options?.maxBytes !== undefined
            && bytesWritten + value.byteLength > options.maxBytes
          ) {
            sizeLimitExceeded = true;
            try {
              await reader.cancel();
            } catch {
              // Preserve the size-limit result when stream cancellation races the source.
            }
            break;
          }
          stdin.write(value);
          bytesWritten += value.byteLength;
        }
      } finally {
        stdin.end();
      }
      const [exitCode, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
      ]);
      if (options?.signal?.aborted) {
        return { success: false, bytesWritten, error: "Write aborted" };
      }
      if (sizeLimitExceeded) {
        return {
          success: false,
          bytesWritten,
          error: "Upload stream exceeds the maximum accepted size",
          errorCode: "size_limit",
        };
      }
      if (exitCode !== 0) {
        return {
          success: false,
          bytesWritten,
          error: stderr.trim() || `SSH file write failed with exit code ${exitCode}`,
        };
      }
      return { success: true, bytesWritten };
    } catch (error) {
      return {
        success: false,
        bytesWritten,
        error: error instanceof DOMException && error.name === "AbortError" ? "Write aborted" : String(error),
      };
    } finally {
      options?.signal?.removeEventListener("abort", abortHandler);
    }
  }

  async copyFile(sourcePath: string, destinationPath: string): Promise<boolean> {
    if (this.localFileSystem) {
      return await this.localFileSystem.copyFile(sourcePath, destinationPath);
    }

    const parentDir = posix.dirname(destinationPath);
    const result = await this.exec("sh", [
      "-lc",
      `mkdir -p ${quoteShell(parentDir)} && cp ${quoteShell(sourcePath)} ${quoteShell(destinationPath)}`,
    ]);
    return result.success;
  }

  async listDirectory(path: string, options?: { includeHidden?: boolean }): Promise<string[]> {
    const includeHidden = options?.includeHidden ?? false;
    if (this.localFileSystem) {
      return await this.localFileSystem.listDirectory(path, options);
    }

    const result = await this.exec("sh", [
      "-c",
      "dir=\"$1\"; include_hidden=\"$2\"; [ -d \"$dir\" ] || exit 2; for entry in \"$dir\"/*; do if [ -e \"$entry\" ] || [ -L \"$entry\" ]; then printf '%s\\0' \"${entry##*/}\"; fi; done; if [ \"$include_hidden\" = 1 ]; then for entry in \"$dir\"/.[!.]* \"$dir\"/..?*; do if [ -e \"$entry\" ] || [ -L \"$entry\" ]; then printf '%s\\0' \"${entry##*/}\"; fi; done; fi",
      "clanky-list-directory",
      path,
      includeHidden ? "1" : "0",
    ], {
      logFailures: false,
    });
    if (!result.success) {
      throw new Error(
        `Failed to list remote directory ${path}: ${
          result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`
        }`,
      );
    }
    return result.stdout
      .split("\0")
      .filter((entry) => entry.length > 0);
  }

  async getFileMetadata(
    path: string,
    options?: { includeContentHash?: boolean },
  ): Promise<FileSystemMetadata | null> {
    if (this.localFileSystem) {
      return await this.localFileSystem.getFileMetadata(path, options);
    }

    const result = await this.exec(
      "sh",
      [
        "-lc",
        "path=\"$1\"; link=0; if [ -L \"$path\" ]; then link=1; fi; if [ \"$link\" = 0 ] && [ ! -e \"$path\" ]; then exit 2; fi; if [ \"$link\" = 1 ] && [ ! -e \"$path\" ]; then printf 'f\\t0\\t0\\t-\\t1\\n'; exit 0; fi; include_hash=\"${2:-1}\"; if [ -d \"$path\" ]; then type_flag=d; hash=-; else type_flag=f; if [ \"$include_hash\" = 1 ]; then if command -v sha256sum >/dev/null 2>&1; then hash=$(sha256sum \"$path\" | cut -d' ' -f1); elif command -v shasum >/dev/null 2>&1; then hash=$(shasum -a 256 \"$path\" | cut -d' ' -f1); else hash=; fi; else hash=-; fi; fi; if stat --version >/dev/null 2>&1; then size=$(stat -c '%s' \"$path\"); modified=$(stat -c '%Y' \"$path\"); else size=$(stat -f '%z' \"$path\"); modified=$(stat -f '%m' \"$path\"); fi; printf '%s\\t%s\\t%s\\t%s\\t%s\\n' \"$type_flag\" \"$size\" \"$modified\" \"$hash\" \"$link\"",
        "clanky-file-metadata",
        path,
        options?.includeContentHash === false ? "0" : "1",
      ],
      { logFailures: false },
    );
    if (!result.success) {
      if (result.exitCode === 2) {
        return null;
      }
      throw new Error(
        result.stderr.trim() || "Failed to read remote file metadata",
      );
    }

    const [
      typeFlag,
      sizeText,
      modifiedText,
      contentHash,
      symbolicLinkText,
    ] = result.stdout.trim().split("\t");
    const size = Number.parseInt(sizeText ?? "", 10);
    const modifiedSeconds = Number.parseFloat(modifiedText ?? "");
    if (
      (typeFlag !== "d" && typeFlag !== "f")
      || !Number.isFinite(size)
      || !Number.isFinite(modifiedSeconds)
      || (symbolicLinkText !== "0" && symbolicLinkText !== "1")
    ) {
      throw new Error("Failed to parse remote file metadata");
    }
    return {
      kind: typeFlag === "d" ? "directory" : "file",
      size,
      modifiedAtMs: modifiedSeconds * 1000,
      ...(contentHash && contentHash !== "-" ? { contentHash } : {}),
      isSymbolicLink: symbolicLinkText === "1",
    };
  }

  async listDirectoryEntries(
    path: string,
    options?: { includeHidden?: boolean },
  ): Promise<FileSystemDirectoryEntry[]> {
    if (this.localFileSystem) {
      return await this.localFileSystem.listDirectoryEntries(path, options);
    }

    const names = await this.listDirectory(path, options);
    const entries = await Promise.all(names.map(async (name) => {
      const metadata = await this.getFileMetadata(
        posix.join(path, name),
        { includeContentHash: false },
      );
      return metadata
        ? {
            name,
            kind: metadata.kind,
            isSymbolicLink: metadata.isSymbolicLink,
          }
        : null;
    }));
    return entries.filter(
      (entry): entry is FileSystemDirectoryEntry => entry !== null,
    );
  }

  async writeFile(path: string, content: string): Promise<boolean> {
    if (this.localFileSystem) {
      return await this.localFileSystem.writeFile(path, content);
    }

    const result = await this.writeFileStream(path, new Blob([content]).stream());
    return result.success;
  }

  async movePath(
    sourcePath: string,
    destinationPath: string,
    options?: FileMoveOptions,
  ): Promise<FileMoveResult> {
    if (this.localFileSystem) {
      return await this.localFileSystem.movePath(
        sourcePath,
        destinationPath,
        options,
      );
    }

    const result = await this.exec("sh", [
      "-lc",
      "src=\"$1\"; dest=\"$2\"; overwrite=\"$3\"; if [ ! -e \"$src\" ] && [ ! -L \"$src\" ]; then exit 2; fi; if [ -e \"$dest\" ] || [ -L \"$dest\" ]; then if [ \"$overwrite\" != 1 ]; then exit 3; fi; if [ -d \"$src\" ] || [ -d \"$dest\" ]; then exit 4; fi; fi; parent=$(dirname -- \"$dest\"); if [ -e \"$parent\" ] && [ ! -d \"$parent\" ]; then exit 5; fi; mkdir -p -- \"$parent\" && mv -- \"$src\" \"$dest\"",
      "clanky-file-move",
      sourcePath,
      destinationPath,
      options?.overwrite ? "1" : "0",
    ], {
      logFailures: false,
    });
    if (result.success) {
      return { success: true };
    }
    const errorCode = result.exitCode === 2
      ? "source_not_found"
      : result.exitCode === 3
        ? "destination_exists"
        : result.exitCode === 4
          ? "incompatible_type"
          : result.exitCode === 5
            ? "invalid_destination_parent"
            : "operation_failed";
    return {
      success: false,
      errorCode,
      ...(result.stderr ? { error: result.stderr } : {}),
    };
  }

  async deletePath(path: string, options: FileDeleteOptions): Promise<boolean> {
    if (this.localFileSystem) {
      return await this.localFileSystem.deletePath(path, options);
    }

    const result = await this.exec("sh", [
      "-lc",
      "path=\"$1\"; kind=\"$2\"; recursive=\"$3\"; if [ ! -e \"$path\" ] && [ ! -L \"$path\" ]; then exit 2; fi; if [ \"$kind\" = directory ]; then [ -d \"$path\" ] || exit 3; if [ \"$recursive\" = 1 ]; then rm -rf -- \"$path\"; else rmdir -- \"$path\"; fi; else [ ! -d \"$path\" ] || exit 3; rm -f -- \"$path\"; fi",
      "clanky-file-delete",
      path,
      options.kind,
      options.recursive ? "1" : "0",
    ], {
      logFailures: false,
    });
    return result.success;
  }
}
