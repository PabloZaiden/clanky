/**
 * CommandExecutorImpl — executes commands either locally or over SSH.
 * Local commands are queued to ensure only one runs at a time per executor
 * instance. SSH commands let the first real command initialize ControlMaster,
 * while concurrent commands wait for that first command and then run in
 * parallel over the shared multiplexed connection.
 */

import { createWriteStream } from "node:fs";
import { mkdir, readdir, stat, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  CommandExecutor,
  CommandResult,
  CommandOptions,
  FileStreamOptions,
  FileWriteStreamOptions,
  FileWriteStreamResult,
} from "../command-executor";
import { log } from "../logger";
import type { CommandExecutorConfig } from "./types";
import { quoteShell, buildEnvAssignments, readProcessStream } from "./utils";
import { buildSshRemoteShellCommand, buildSshCommandArgs } from "./ssh-helpers";

const LOG_PREFIX = "[CommandExecutor]";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

const sshControlMasterInitializers = new Map<string, Promise<CommandResult>>();
interface StreamedProcess {
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

function createProcessStdoutStream(
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

  return new ReadableStream<Uint8Array>({
    async start(controller: ReadableStreamDefaultController<Uint8Array>) {
      const stdoutReader = stdout.getReader();
      reader = stdoutReader;
      abortHandler = () => {
        markCancelled();
        void stdoutReader.cancel().catch(() => undefined);
        killProcess();
      };

      try {
        if (signal?.aborted) {
          abortHandler();
          controller.error(new Error(`${label} aborted`));
          return;
        }

        signal?.addEventListener("abort", abortHandler, { once: true });

        while (true) {
          const { done, value } = await stdoutReader.read();
          if (done) {
            break;
          }
          if (cancelled) {
            return;
          }
          controller.enqueue(value);
        }

        if (cancelled) {
          return;
        }

        const processResult = await Promise.race([
          processCompletionPromise,
          cancelledPromise,
        ]);
        if (processResult === "cancelled" || cancelled) {
          return;
        }
        if (processResult.type === "error") {
          controller.error(
            processResult.error instanceof Error
              ? processResult.error
              : new Error(String(processResult.error)),
          );
          return;
        }
        if (processResult.exitCode !== 0) {
          controller.error(
            new Error(processResult.stderr.trim() || `${label} failed with exit code ${processResult.exitCode}`),
          );
          return;
        }
        controller.close();
      } catch (error) {
        if (!cancelled) {
          controller.error(error instanceof Error ? error : new Error(String(error)));
        }
      } finally {
        cleanup();
        try {
          stdoutReader.releaseLock();
        } catch {
          // The reader may already be released by an abort-before-start cleanup.
        }
      }
    },
    cancel() {
      markCancelled();
      cleanup();
      void reader?.cancel().catch(() => undefined);
      killProcess();
    },
  });
}

export class CommandExecutorImpl implements CommandExecutor {
  private readonly provider: "local" | "ssh";
  private readonly directory: string;
  private readonly host?: string;
  private readonly port: number;
  private readonly user?: string;
  private readonly password?: string;
  private readonly identityFile?: string;
  private readonly defaultTimeoutMs: number;

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
    this.directory = config.directory;
    this.host = config.host;
    this.port = config.port ?? 22;
    this.user = config.user;
    this.password = config.password;
    this.identityFile = config.identityFile?.trim() || undefined;
    this.defaultTimeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Execute a shell command.
   */
  async exec(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
    const cmdStr = `${command} ${args.join(" ")}`;
    const executeCommand = async (): Promise<CommandResult> => {
      const cwd = options?.cwd ?? this.directory;
      const timeout = options?.timeout ?? this.defaultTimeoutMs;
      const env = options?.env;
      const signal = options?.signal;
      const onStdoutChunk = options?.onStdoutChunk;
      const onStderrChunk = options?.onStderrChunk;
      const result = this.provider === "ssh"
        ? await this.execSsh(command, args, cwd, timeout, env, signal, onStdoutChunk, onStderrChunk)
        : await this.execLocal(command, args, cwd, timeout, env, signal, onStdoutChunk, onStderrChunk);

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
    timeoutMs: number,
    env?: Record<string, string>,
    signal?: AbortSignal,
    onStdoutChunk?: (chunk: string) => void,
    onStderrChunk?: (chunk: string) => void,
  ): Promise<CommandResult> {
    try {
      if (signal?.aborted) {
        return {
          success: false,
          stdout: "",
          stderr: "Command aborted",
          exitCode: 130,
        };
      }

      const proc = Bun.spawn([command, ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });

      const stdoutPromise = readProcessStream(proc.stdout, onStdoutChunk);
      const stderrPromise = readProcessStream(proc.stderr, onStderrChunk);

      let timedOut = false;
      let aborted = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let abortHandler: (() => void) | undefined;
      const timeoutPromise = new Promise<number>((resolve) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          try {
            proc.kill();
          } catch {
            // Ignore kill errors during timeout cleanup
          }
          resolve(124);
        }, timeoutMs);
      });

      const abortPromise = new Promise<number>((resolve) => {
        if (!signal) {
          return;
        }

        if (signal.aborted) {
          aborted = true;
          try {
            proc.kill();
          } catch {
            // Ignore kill errors during abort cleanup
          }
          resolve(130);
          return;
        }

        abortHandler = () => {
          aborted = true;
          try {
            proc.kill();
          } catch {
            // Ignore kill errors during abort cleanup
          }
          resolve(130);
        };

        signal.addEventListener("abort", abortHandler, { once: true });
      });

      const racedExitCode = await Promise.race([
        proc.exited,
        timeoutPromise,
        ...(signal ? [abortPromise] : []),
      ]);
      clearTimeout(timeoutId);
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }

      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

      if (timedOut) {
        return {
          success: false,
          stdout,
          stderr: stderr || `Command timed out after ${timeoutMs}ms`,
          exitCode: racedExitCode,
        };
      }

      if (aborted || signal?.aborted) {
        return {
          success: false,
          stdout,
          stderr: stderr || "Command aborted",
          exitCode: racedExitCode,
        };
      }

      return {
        success: racedExitCode === 0,
        stdout,
        stderr,
        exitCode: racedExitCode,
      };
    } catch (error) {
      return {
        success: false,
        stdout: "",
        stderr: String(error),
        exitCode: 1,
      };
    }
  }

  private async execSsh(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    env?: Record<string, string>,
    signal?: AbortSignal,
    onStdoutChunk?: (chunk: string) => void,
    onStderrChunk?: (chunk: string) => void,
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
      );
    }

    return await this.execBatchSshWithInitialGate(
      sshTarget,
      remoteShellCommand,
      timeoutMs,
      signal,
      onStdoutChunk,
      onStderrChunk,
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
    timeoutMs: number,
    signal?: AbortSignal,
    onStdoutChunk?: (chunk: string) => void,
    onStderrChunk?: (chunk: string) => void,
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
      );
    }

    const currentCommand = this.execBatchSshCommand(
      sshTarget,
      remoteShellCommand,
      timeoutMs,
      signal,
      onStdoutChunk,
      onStderrChunk,
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
    timeoutMs: number,
    signal?: AbortSignal,
    onStdoutChunk?: (chunk: string) => void,
    onStderrChunk?: (chunk: string) => void,
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
    );
  }

  async fileExists(path: string): Promise<boolean> {
    const result = await this.exec("test", ["-f", path]);
    return result.success;
  }

  async directoryExists(path: string): Promise<boolean> {
    const result = await this.exec("test", ["-d", path]);
    return result.success;
  }

  async readFile(path: string): Promise<string | null> {
    if (this.provider === "local") {
      try {
        const file = Bun.file(path);
        if (!(await file.exists())) {
          return null;
        }
        return await file.text();
      } catch {
        return null;
      }
    }

    const result = await this.exec("cat", [path]);
    if (!result.success) {
      return null;
    }
    return result.stdout;
  }

  async streamFile(path: string, options?: FileStreamOptions): Promise<ReadableStream<Uint8Array> | null> {
    if (this.provider === "local") {
      try {
        const fileStat = await stat(path);
        if (!fileStat.isFile()) {
          return null;
        }
        return Bun.file(path).stream();
      } catch {
        return null;
      }
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
    if (this.provider === "local") {
      try {
        if (options?.signal?.aborted) {
          return { success: false, bytesWritten: 0, error: "Write aborted" };
        }

        await mkdir(dirname(path), { recursive: true });
        const expectedOffset = options?.expectedOffset;
        if (expectedOffset !== undefined) {
          let currentSize = 0;
          try {
            currentSize = (await stat(path)).size;
          } catch {
            currentSize = 0;
          }
          if (options?.append && currentSize > expectedOffset) {
            await truncate(path, expectedOffset);
            currentSize = expectedOffset;
          }
          if (currentSize !== expectedOffset) {
            return {
              success: false,
              bytesWritten: 0,
              error: `Expected file offset ${expectedOffset}, found ${currentSize}`,
            };
          }
        }

        const writeStream = createWriteStream(path, {
          flags: options?.append && expectedOffset !== 0 ? "r+" : "w",
          ...(options?.append ? { start: expectedOffset ?? 0 } : {}),
        });
        const reader = stream.getReader();
        let bytesWritten = 0;
        try {
          while (true) {
            if (options?.signal?.aborted) {
              return { success: false, bytesWritten, error: "Write aborted" };
            }
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            const canContinue = writeStream.write(value);
            bytesWritten += value.byteLength;
            if (!canContinue) {
              await new Promise<void>((resolve, reject) => {
                writeStream.once("drain", resolve);
                writeStream.once("error", reject);
              });
            }
          }
        } finally {
          await new Promise<void>((resolve, reject) => {
            writeStream.end(() => resolve());
            writeStream.once("error", reject);
          });
        }

        return { success: true, bytesWritten };
      } catch (error) {
        return { success: false, bytesWritten: 0, error: String(error) };
      }
    }

    if (!this.host) {
      return { success: false, bytesWritten: 0, error: "SSH file streaming requires execution host" };
    }

    const parentDir = dirname(path);
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

  async listDirectory(path: string, options?: { includeHidden?: boolean }): Promise<string[]> {
    const includeHidden = options?.includeHidden ?? false;
    if (this.provider === "local") {
      try {
        const entries = await readdir(path);
        return includeHidden ? entries : entries.filter((entry) => !entry.startsWith("."));
      } catch {
        return [];
      }
    }

    const result = await this.exec("ls", [includeHidden ? "-1A" : "-1", path]);
    if (!result.success) {
      return [];
    }
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async writeFile(path: string, content: string): Promise<boolean> {
    if (this.provider === "local") {
      try {
        await mkdir(dirname(path), { recursive: true });
        await Bun.write(path, content);
        return true;
      } catch {
        return false;
      }
    }

    const parentDir = dirname(path);
    const base64Content = Buffer.from(content, "utf8").toString("base64");
    const result = await this.exec("sh", [
      "-lc",
      `mkdir -p ${quoteShell(parentDir)} && printf %s ${quoteShell(base64Content)} | base64 -d > ${quoteShell(path)}`,
    ]);
    return result.success;
  }
}
