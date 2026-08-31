/**
 * Native Bun PTY connection used for local and Mesh-peer terminals.
 */

import type { CommandExecutor } from "../command-executor";
import {
  buildPersistentSessionAttachCommand,
  buildPersistentSessionBackendInstallHint,
  buildPersistentSessionBackendProbeCommand,
  buildPersistentSessionReadyCommand,
  PERSISTENT_SESSION_ATTACH_UNAVAILABLE_EXIT_CODE,
} from "../ssh-persistent-session";
import { buildShellBootstrapCommand } from "../ssh-shell-bootstrap";
import { DEFAULT_SSH_COLOR_TERM, DEFAULT_SSH_TERM } from "../ssh-terminal-env";
import {
  DEFAULT_SESSION_READY_TIMEOUT_MS,
  SESSION_READY_POLL_INTERVAL_MS,
} from "../ssh-bridge/constants";
import { buildManagedContextStdinPayload } from "../managed-context-environment";
import type { TerminalConnectionMode } from "@/shared/terminal-session";
import type {
  InteractiveTerminalCallbacks,
  InteractiveTerminalConnection,
  InteractiveTerminalConnectResult,
} from "./interactive-terminal-connection";
import { TerminalOutput } from "./terminal-output";
import { DomainError } from "../domain-error";
import { createLogger } from "@pablozaiden/webapp/server";

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const PROCESS_TERMINATION_GRACE_MS = 1_000;
const SAFE_ENVIRONMENT_KEYS = new Set([
  "COLORTERM",
  "DISPLAY",
  "HOME",
  "LANG",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TZ",
  "USER",
  "WAYLAND_DISPLAY",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
]);
const log = createLogger("core:terminal:local");

export interface LocalTerminalConnectionConfig {
  sessionId: string;
  remoteSessionName: string;
  directory: string;
  connectionMode: TerminalConnectionMode;
  runtimeConnectionMode?: TerminalConnectionMode;
  useTmux: boolean;
  executor: CommandExecutor;
  environment?: Record<string, string>;
  callbacks: InteractiveTerminalCallbacks;
  readyTimeoutMs?: number;
  allowPersistentSessionCreate?: boolean;
  onRuntimeConnectionState?: (
    state: { runtimeConnectionMode?: TerminalConnectionMode; notice?: string },
  ) => Promise<void>;
  onPersistentSessionAttachUnavailable?: () => Promise<{
    environment?: Record<string, string>;
    notice?: string;
  }>;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function buildDirectTtyFilePath(sessionId: string): string {
  return `/tmp/clanky-terminal-${sessionId}.tty`;
}

function buildDirectShellCommand(config: LocalTerminalConnectionConfig): string {
  const ttyFile = quoteShell(buildDirectTtyFilePath(config.sessionId));
  return [
    `tty_file=${ttyFile}`,
    "tty_path=$(tty);",
    "if [ -z \"$tty_path\" ] || [ \"$tty_path\" = \"not a tty\" ]; then",
    "echo 'Failed to determine terminal tty.' >&2;",
    "exit 1;",
    "fi;",
    "printf '%s\\n' \"$tty_path\" > \"$tty_file\";",
    "trap 'rm -f \"$tty_file\"' EXIT HUP INT TERM;",
    buildShellBootstrapCommand({
      directory: config.directory,
      useTmux: config.useTmux,
    }),
  ].join(" ");
}

function buildDirectReadyCommand(sessionId: string): string {
  const ttyFile = quoteShell(buildDirectTtyFilePath(sessionId));
  return [
    `tty_file=${ttyFile}`,
    "test -r \"$tty_file\"",
    "tty_path=$(cat \"$tty_file\" 2>/dev/null || true)",
    "test -n \"$tty_path\"",
  ].join("\n");
}

function buildSafeEnvironment(extra?: Record<string, string>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined
      && (SAFE_ENVIRONMENT_KEYS.has(key) || key.startsWith("LC_"))
    ) {
      environment[key] = value;
    }
  }
  environment["PATH"] = environment["PATH"] ?? "/usr/local/bin:/usr/bin:/bin";
  environment["SHELL"] = environment["SHELL"] ?? "/bin/sh";
  environment["TERM"] = environment["TERM"] ?? DEFAULT_SSH_TERM;
  environment["COLORTERM"] = environment["COLORTERM"] ?? DEFAULT_SSH_COLOR_TERM;
  for (const [key, value] of Object.entries(extra ?? {})) {
    environment[key] = value;
  }
  return environment;
}

function normalizeSize(value: number, minimum: number): number {
  return Math.max(minimum, Math.floor(value));
}

export class LocalTerminalConnection implements InteractiveTerminalConnection {
  private terminal: Bun.Terminal | null = null;
  private process: Bun.Subprocess | null = null;
  private connectPromise: Promise<InteractiveTerminalConnectResult> | null = null;
  private disposePromise: Promise<void> | null = null;
  private disposed = false;
  private ready = false;
  private output: TerminalOutput;
  private activeMode: TerminalConnectionMode;
  private runtimeEnvironment?: Record<string, string>;
  private allowPersistentSessionCreate: boolean;
  private persistentAttachRetried = false;
  private suppressNextExitNotification = false;
  private clientTtyCleanupDone = false;

  constructor(private readonly config: LocalTerminalConnectionConfig) {
    this.output = new TerminalOutput(config.callbacks);
    this.activeMode = config.runtimeConnectionMode ?? config.connectionMode;
    this.runtimeEnvironment = config.environment;
    this.allowPersistentSessionCreate = config.allowPersistentSessionCreate ?? true;
  }

  async connect(): Promise<InteractiveTerminalConnectResult> {
    this.assertNotDisposed();
    if (this.ready && this.process?.exitCode === null) {
      return { runtimeConnectionMode: this.activeMode };
    }
    if (this.connectPromise) {
      return await this.connectPromise;
    }
    const pending = this.connectInternal();
    this.connectPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.connectPromise === pending) {
        this.connectPromise = null;
      }
    }
  }

  private async connectInternal(): Promise<InteractiveTerminalConnectResult> {
    if (this.disposed) {
      throw new DomainError("terminal_connection_closed", "The terminal connection is closed.");
    }
    if (!await this.config.executor.directoryExists(this.config.directory)) {
      throw new DomainError(
        "terminal_directory_unavailable",
        "The terminal working directory does not exist on the execution host.",
        { details: { directory: this.config.directory } },
      );
    }
    this.assertNotDisposed();

    let notice: string | undefined;
    if (this.config.connectionMode === "dtach") {
      const probe = await this.config.executor.exec(
        "bash",
        ["-lc", buildPersistentSessionBackendProbeCommand()],
        {
          cwd: this.config.directory,
          timeout: DEFAULT_COMMAND_TIMEOUT_MS,
          logFailures: false,
        },
      );
      if (!probe.success) {
        if (probe.exitCode !== 1 && probe.exitCode !== 127) {
          throw new DomainError(
            "terminal_persistent_backend_probe_failed",
            probe.stderr.trim() || probe.stdout.trim() || "Failed to verify the persistent terminal backend.",
          );
        }
        this.activeMode = "direct";
        notice = buildPersistentSessionBackendInstallHint()
          .replace("remote host", "execution host")
          .replace("Direct SSH", "Direct");
        await this.config.onRuntimeConnectionState?.({
          runtimeConnectionMode: "direct",
          notice,
        });
        this.assertNotDisposed();
      } else {
        this.activeMode = "dtach";
        if (this.config.runtimeConnectionMode || notice) {
          await this.config.onRuntimeConnectionState?.({});
          this.assertNotDisposed();
        }
      }
    } else {
      this.activeMode = "direct";
      if (this.config.runtimeConnectionMode) {
        await this.config.onRuntimeConnectionState?.({});
        this.assertNotDisposed();
      }
    }

    this.assertNotDisposed();
    this.persistentAttachRetried = false;
    return await this.connectPty(notice);
  }

  private async connectPty(notice?: string): Promise<InteractiveTerminalConnectResult> {
    this.assertNotDisposed();
    const command = this.activeMode === "dtach"
      ? buildPersistentSessionAttachCommand({
          config: {
            id: this.config.sessionId,
            remoteSessionName: this.config.remoteSessionName,
            directory: this.config.directory,
            useTmux: this.config.useTmux,
          },
        }, this.runtimeEnvironment, {
          allowCreate: this.allowPersistentSessionCreate,
        })
      : buildDirectShellCommand(this.config);
    const terminal = new Bun.Terminal({
      cols: 80,
      rows: 24,
      name: DEFAULT_SSH_TERM,
      data: (_terminal, data) => {
        this.output.write(data);
      },
      exit: (_terminal, exitCode) => {
        if (
          exitCode !== 0
          && !this.disposed
          && !(
            this.activeMode === "dtach"
            && !this.allowPersistentSessionCreate
            && exitCode === PERSISTENT_SESSION_ATTACH_UNAVAILABLE_EXIT_CODE
          )
        ) {
          this.config.callbacks.onError?.(new Error("The terminal PTY stream closed unexpectedly."));
        }
      },
    });
    this.terminal = terminal;

    let processHandle: Bun.Subprocess;
    try {
      processHandle = Bun.spawn(["bash", "-lc", command], {
        cwd: "/",
        env: buildSafeEnvironment(this.runtimeEnvironment),
        terminal,
      });
    } catch (error) {
      terminal.close();
      this.terminal = null;
      throw new DomainError(
        "terminal_process_spawn_failed",
        "Failed to start the terminal process.",
        { cause: error },
      );
    }
    this.process = processHandle;
    const startupStdin = this.activeMode === "dtach"
      ? buildManagedContextStdinPayload(this.runtimeEnvironment)
      : undefined;
    if (startupStdin) {
      terminal.write(startupStdin);
    }
    void processHandle.exited.then((exitCode) => {
      this.handleProcessExit(processHandle, exitCode);
    }).catch((error: Error) => {
      if (!this.disposed) {
        this.config.callbacks.onError?.(error);
      }
    });

    try {
      await this.waitUntilReady(processHandle);
      this.assertNotDisposed();
      this.ready = true;
      return {
        runtimeConnectionMode: this.activeMode,
        ...(notice ? { notice } : {}),
      };
    } catch (error) {
      this.ready = false;
      const shouldRetry = this.isPersistentAttachUnavailable(error, processHandle);
      if (shouldRetry) {
        this.suppressNextExitNotification = true;
      }
      if (processHandle.exitCode === null) {
        await this.terminateProcess(processHandle);
      }
      if (shouldRetry && !this.disposed && !this.persistentAttachRetried) {
        const recovery = await this.config.onPersistentSessionAttachUnavailable?.();
        if (recovery) {
          this.persistentAttachRetried = true;
          this.runtimeEnvironment = recovery.environment;
          this.allowPersistentSessionCreate = true;
          return await this.connectPty(recovery.notice ?? notice);
        }
      }
      throw error;
    }
  }

  sendInput(data: string): void {
    if (!this.ready || !this.terminal || this.terminal.closed) {
      throw new DomainError("terminal_connection_unavailable", "The terminal connection is not writable.");
    }
    this.terminal.write(data);
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (!this.ready || !this.terminal || this.terminal.closed) {
      throw new DomainError("terminal_connection_unavailable", "The terminal connection is not connected.");
    }
    this.terminal.resize(normalizeSize(cols, 2), normalizeSize(rows, 1));
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) {
      return await this.disposePromise;
    }
    const pending = this.disposeInternal();
    this.disposePromise = pending;
    try {
      await pending;
    } finally {
      if (this.disposePromise === pending) {
        this.disposePromise = null;
      }
    }
  }

  private async disposeInternal(): Promise<void> {
    this.disposed = true;
    this.ready = false;
    const processHandle = this.process;
    if (processHandle?.exitCode === null) {
      await this.terminateProcess(processHandle);
    }
    this.process = null;
    if (this.terminal && !this.terminal.closed) {
      this.terminal.close();
    }
    this.terminal = null;
    try {
      await this.cleanupClientTtyFile();
    } catch (error) {
      log.warn("Failed to clean up the terminal client tty file", {
        sessionId: this.config.sessionId,
        error: String(error),
      });
    }
    this.output.flush();
  }

  private async waitUntilReady(processHandle: Bun.Subprocess): Promise<void> {
    const deadline = Date.now() + (this.config.readyTimeoutMs ?? DEFAULT_SESSION_READY_TIMEOUT_MS);
    const command = this.activeMode === "dtach"
      ? buildPersistentSessionReadyCommand({
          config: {
            id: this.config.sessionId,
            remoteSessionName: this.config.remoteSessionName,
          },
        })
      : buildDirectReadyCommand(this.config.sessionId);
    while (Date.now() < deadline) {
      this.assertNotDisposed();
      if (processHandle.exitCode !== null) {
        if (
          this.activeMode === "dtach"
          && !this.allowPersistentSessionCreate
          && processHandle.exitCode === PERSISTENT_SESSION_ATTACH_UNAVAILABLE_EXIT_CODE
        ) {
          throw new DomainError(
            "terminal_persistent_session_attach_unavailable",
            "The persistent terminal session is no longer available for attach.",
            { details: { exitCode: processHandle.exitCode } },
          );
        }
        throw new DomainError(
          "terminal_process_exited",
          `The terminal process exited before it became ready (code ${String(processHandle.exitCode)}).`,
        );
      }
      const result = await this.config.executor.exec("bash", ["-lc", command], {
        cwd: this.config.directory,
        timeout: Math.min(DEFAULT_COMMAND_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
        logFailures: false,
      });
      if (result.success) {
        return;
      }
      this.assertNotDisposed();
      await Bun.sleep(SESSION_READY_POLL_INTERVAL_MS);
    }
    throw new DomainError("terminal_ready_timeout", "Timed out waiting for the terminal shell to become ready.");
  }

  private handleProcessExit(processHandle: Bun.Subprocess, exitCode: number): void {
    if (this.process !== processHandle) {
      return;
    }
    this.ready = false;
    this.process = null;
    this.output.flush();
    if (this.terminal && !this.terminal.closed) {
      this.terminal.close();
    }
    this.terminal = null;
    void this.cleanupClientTtyFile().catch((error: Error) => {
      log.warn("Failed to clean up the terminal client tty file after process exit", {
        sessionId: this.config.sessionId,
        error: String(error),
      });
    });
    const suppressExitNotification = this.suppressNextExitNotification
      || (
        this.activeMode === "dtach"
        && !this.allowPersistentSessionCreate
        && exitCode === PERSISTENT_SESSION_ATTACH_UNAVAILABLE_EXIT_CODE
      );
    this.suppressNextExitNotification = false;
    if (!this.disposed && !suppressExitNotification) {
      this.config.callbacks.onExit?.(exitCode, processHandle.signalCode);
    }
  }

  private isPersistentAttachUnavailable(error: unknown, processHandle: Bun.Subprocess): boolean {
    return (
      this.activeMode === "dtach"
      && !this.allowPersistentSessionCreate
      && processHandle.exitCode === PERSISTENT_SESSION_ATTACH_UNAVAILABLE_EXIT_CODE
      && error instanceof DomainError
      && error.code === "terminal_process_exited"
    );
  }

  private async cleanupClientTtyFile(): Promise<void> {
    if (this.clientTtyCleanupDone) {
      return;
    }
    const result = await this.config.executor.exec(
      "rm",
      ["-f", buildDirectTtyFilePath(this.config.sessionId)],
      {
        cwd: this.config.directory,
        timeout: DEFAULT_COMMAND_TIMEOUT_MS,
        logFailures: false,
      },
    );
    if (!result.success) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "Failed to remove the terminal client tty file");
    }
    this.clientTtyCleanupDone = true;
  }

  private async terminateProcess(processHandle: Bun.Subprocess): Promise<void> {
    if (processHandle.exitCode !== null) {
      return;
    }

    processHandle.kill("SIGTERM");
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        processHandle.exited,
        new Promise<void>((resolve) => {
          graceTimer = setTimeout(resolve, PROCESS_TERMINATION_GRACE_MS);
        }),
      ]);
    } finally {
      if (graceTimer) {
        clearTimeout(graceTimer);
      }
    }

    if (processHandle.exitCode === null) {
      processHandle.kill("SIGKILL");
    }
    await processHandle.exited.catch(() => undefined);
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new DomainError("terminal_connection_closed", "The terminal connection is closed.");
    }
  }
}
