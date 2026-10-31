/**
 * Executes local commands with owned process-tree cleanup.
 * Commands are queued per executor unless explicitly long-running.
 */

import type {
  CommandExecutor,
  CommandResult,
  CommandOptions,
  FileDeleteOptions,
  FileMoveOptions,
  FileMoveResult,
  FileStreamOptions,
  FileSystemDirectoryEntry,
  FileSystemListOptions,
  FileSystemMetadata,
  FileSystemMetadataOptions,
  FileWriteStreamOptions,
  FileWriteStreamResult,
  GitCommandOptions,
  GitEnvironmentVariableName,
} from "../command-executor";
import { CommandOutputLimitError } from "../command-executor";
import { log } from "@pablozaiden/webapp/server";
import type { CommandExecutorConfig } from "./types";
import { readProcessStream } from "./utils";
import { LocalFileSystem } from "./local-filesystem";
import {
  resolveExecutionPathUnscoped,
  type ExecutionPathStyle,
} from "../execution-path";
import type { AgentProvider } from "@/shared/settings";
import { isAgentProviderAvailable } from "../agent-runtime-command";
import { terminateSubprocessTree } from "../subprocess-termination";

const LOG_PREFIX = "[CommandExecutor]";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const POSIX_DEFAULT_PATH =
  "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin";

function inheritedExecutableSearchPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return environment["PATH"]?.trim() ? environment["PATH"] : POSIX_DEFAULT_PATH;
}

export class CommandExecutorImpl implements CommandExecutor {
  readonly pathStyle: ExecutionPathStyle;
  private readonly directory: string;
  private readonly defaultTimeoutMs: number;
  private readonly localFileSystem = new LocalFileSystem();
  private executionDirectoryPromise: Promise<string> | undefined;

  private commandQueue: Array<{
    execute: () => Promise<CommandResult>;
    resolve: (result: CommandResult) => void;
    reject: (error: Error) => void;
  }> = [];
  private isExecuting = false;

  constructor(config: CommandExecutorConfig) {
    this.pathStyle = this.localFileSystem.pathStyle;
    this.directory = config.directory;
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
    return resolveExecutionPathUnscoped(
      process.cwd(),
      this.directory,
      this.pathStyle,
    );
  }

  async getEnvironmentVariable(name: string): Promise<string | null> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }
    return process.env[name] ?? null;
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
    return isAgentProviderAvailable(provider);
  }

  async exec(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
    const cmdStr = `${command} ${args.join(" ")}`;
    const executeCommand = async (): Promise<CommandResult> => {
      const cwd = options?.cwd ?? this.directory;
      const timeout = options?.timeout === null
        ? undefined
        : options?.timeout ?? this.defaultTimeoutMs;
      let localStarted = false;
      const result = await this.execLocal(
        command,
        args,
        cwd,
        timeout,
        options?.env,
        options?.signal,
        options?.onStdoutChunk,
        options?.onStderrChunk,
        options?.maxOutputBytes,
        (state) => {
          if (state === "started") localStarted = true;
          options?.onExecutionState?.(state);
        },
      );
      if (localStarted || !result.termination) {
        options?.onExecutionState?.("finished");
      }

      if (!result.success && options?.logFailures !== false) {
        log.error(`${LOG_PREFIX} Command failed: ${cmdStr}`);
        log.error(`${LOG_PREFIX}   exitCode: ${result.exitCode}`);
        if (result.stderr) {
          log.error(`${LOG_PREFIX}   stderr: ${result.stderr}`);
        }
      }
      return result;
    };

    if (options?.longRunning) {
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
    onExecutionState?: CommandOptions["onExecutionState"],
  ): Promise<CommandResult> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;
    let spawnedProcess: ReturnType<typeof Bun.spawn> | undefined;
    try {
      if (signal?.aborted) {
        return {
          success: false,
          stdout: "",
          stderr: "Command aborted",
          exitCode: 130,
          termination: "confirmed",
        };
      }

      const executableSearchPath = inheritedExecutableSearchPath();
      const commandEnv = {
        ...process.env,
        ...(executableSearchPath ? { PATH: executableSearchPath } : {}),
        ...env,
      };

      onExecutionState?.("dispatched");
      const subprocess = Bun.spawn([command, ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: commandEnv,
      });
      spawnedProcess = subprocess;
      onExecutionState?.("started");
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
              termination: "failed",
            }
          : {
              success: false,
              stdout: "",
              stderr: `Command aborted. ${cleanupMessage}`,
              exitCode: 130,
              termination: "failed",
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
          termination: "confirmed",
        };
      }

      if (aborted || signal?.aborted) {
        return {
          success: false,
          stdout,
          stderr: stderr || "Command aborted",
          exitCode: 130,
          termination: aborted ? "confirmed" : undefined,
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
      if (spawnedProcess?.exitCode === null) {
        await terminateSubprocessTree(spawnedProcess, { requireExit: true });
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

  async fileExists(path: string): Promise<boolean> {
    return await this.localFileSystem.fileExists(path);
  }

  async directoryExists(path: string): Promise<boolean> {
    return await this.localFileSystem.directoryExists(path);
  }

  async readFile(path: string, options?: FileStreamOptions): Promise<string | null> {
    return await this.localFileSystem.readFile(path, options);
  }

  async streamFile(path: string, options?: FileStreamOptions): Promise<ReadableStream<Uint8Array> | null> {
    return await this.localFileSystem.streamFile(path, options);
  }

  async writeFileStream(
    path: string,
    stream: ReadableStream<Uint8Array>,
    options?: FileWriteStreamOptions,
  ): Promise<FileWriteStreamResult> {
    return await this.localFileSystem.writeFileStream(path, stream, options);
  }

  async copyFile(sourcePath: string, destinationPath: string): Promise<boolean> {
    return await this.localFileSystem.copyFile(sourcePath, destinationPath);
  }

  async listDirectory(path: string, options?: FileSystemListOptions): Promise<string[]> {
    return await this.localFileSystem.listDirectory(path, options);
  }

  async getFileMetadata(
    path: string,
    options?: FileSystemMetadataOptions,
  ): Promise<FileSystemMetadata | null> {
    return await this.localFileSystem.getFileMetadata(path, options);
  }

  async listDirectoryEntries(
    path: string,
    options?: FileSystemListOptions,
  ): Promise<FileSystemDirectoryEntry[]> {
    return await this.localFileSystem.listDirectoryEntries(path, options);
  }

  async writeFile(path: string, content: string): Promise<boolean> {
    return await this.localFileSystem.writeFile(path, content);
  }

  async movePath(
    sourcePath: string,
    destinationPath: string,
    options?: FileMoveOptions,
  ): Promise<FileMoveResult> {
    return await this.localFileSystem.movePath(sourcePath, destinationPath, options);
  }

  async deletePath(path: string, options: FileDeleteOptions): Promise<boolean> {
    return await this.localFileSystem.deletePath(path, options);
  }
}
