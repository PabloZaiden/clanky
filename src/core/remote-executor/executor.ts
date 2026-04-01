/**
 * CommandExecutorImpl — executes commands either locally or over SSH.
 * Commands are queued to ensure only one runs at a time per executor instance.
 */

import { mkdir, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { CommandExecutor, CommandResult, CommandOptions } from "../command-executor";
import { log } from "../logger";
import type { CommandExecutorConfig } from "./types";
import { quoteShell, buildEnvAssignments, readProcessStream } from "./utils";
import { buildSshRemoteShellCommand, buildSshCommandArgs } from "./ssh-helpers";

const LOG_PREFIX = "[CommandExecutor]";
const DEFAULT_TIMEOUT_MS = 120_000;

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
   * Commands are queued and executed one at a time.
   */
  async exec(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
    const cmdStr = `${command} ${args.join(" ")}`;

    return new Promise<CommandResult>((resolve, reject) => {
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

    return await this.execLocal(
      "ssh",
      buildSshCommandArgs({
        authMode: "batch",
        port: this.port,
        target: sshTarget,
        remoteCommand: remoteShellCommand,
        identityFile: this.identityFile,
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

  async listDirectory(path: string, options?: { includeHidden?: boolean }): Promise<string[]> {
    const includeHidden = options?.includeHidden ?? true;
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
