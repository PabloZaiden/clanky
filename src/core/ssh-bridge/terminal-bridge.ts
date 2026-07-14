/**
 * SshTerminalBridge class — bridges WebSocket terminal sessions over SSH.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import type { CommandExecutor } from "../command-executor";
import type { SshConnectionMode, SshServerSession, SshSession, Workspace } from "@/shared";
import { getWorkspace } from "../../persistence/workspaces";
import {
  buildPersistentSessionBackendInstallHint,
  buildPersistentSessionBackendProbeCommand,
  buildPersistentSessionReadyCommand,
  buildPersistentSessionResizeCommand,
} from "../ssh-persistent-session";
import { sshSessionManager } from "../ssh-session-manager";
import { sshServerManager } from "../ssh-server-manager";
import { createLogger } from "../logger";
import { backendManager } from "../backend-manager";
import { getEffectiveSshConnectionMode } from "../../utils";
import type { SshTerminalBridgeOptions, SshTerminalBridgeConnectOptions } from "./types";
import {
  SESSION_READY_POLL_INTERVAL_MS,
  DEFAULT_SESSION_READY_TIMEOUT_MS,
  MAX_SESSION_READY_PROBE_TIMEOUT_MS,
  DEFAULT_SSH_TERMINAL_COMMAND_TIMEOUT_MS,
  MAX_PENDING_OSC_SEQUENCE_BYTES,
} from "./constants";
import {
  buildSshSpawnConfig,
  buildStandaloneSshSpawnConfig,
  buildDirectReadyCommand,
  buildDirectResizeCommand,
} from "./command-builders";
import { extractClipboardSequences } from "./osc52";
import { requireCurrentUser, runWithCurrentUser } from "../user-context";

const log = createLogger("core:ssh-terminal-bridge");

export class SshTerminalBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private session: SshSession | null = null;
  private standaloneSession: SshServerSession | null = null;
  private workspace: Workspace | null = null;
  private standaloneExecutor: CommandExecutor | null = null;
  private commandCwd = "/";
  private closing = false;
  private ready = false;
  private connectPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private skipCloseStatusUpdate = false;
  private startupError: string | undefined;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private user: CurrentUser | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly options: SshTerminalBridgeOptions,
    private readonly connectOptions: SshTerminalBridgeConnectOptions = {},
  ) {}

  async connect(): Promise<void> {
    if (this.ready && this.proc && this.proc.exitCode === null && this.proc.signalCode === null) {
      return;
    }
    if (this.connectPromise) {
      return await this.connectPromise;
    }

    const pendingConnect = this.connectInternal();
    this.connectPromise = pendingConnect;
    try {
      await pendingConnect;
    } finally {
      if (this.connectPromise === pendingConnect) {
        this.connectPromise = null;
      }
    }
  }

  private async connectInternal(): Promise<void> {
    this.user = requireCurrentUser();
    this.closing = false;
    this.ready = false;
    this.skipCloseStatusUpdate = false;
    this.startupError = undefined;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";

    this.session = await sshSessionManager.getSession(this.sessionId);
    let spawnConfig: { command: string; args: string[]; env: NodeJS.ProcessEnv };
    if (this.connectOptions.sessionKind === "standalone") {
      const connection = await sshServerManager.getTerminalConnection(
        this.sessionId,
        this.connectOptions.credentialToken ?? "",
      );
      this.session = null;
      this.workspace = null;
      this.standaloneSession = await this.resolveStandaloneSessionMode(connection.session, connection.executor);
      this.standaloneExecutor = connection.executor;
      this.commandCwd = "/";
      await sshServerManager.markStatus(this.sessionId, "connecting");
      spawnConfig = buildStandaloneSshSpawnConfig(connection.target, this.standaloneSession);
    } else {
      if (!this.session) {
        throw new Error(`SSH session not found: ${this.sessionId}`);
      }

      this.workspace = await getWorkspace(this.session.config.workspaceId);
      if (!this.workspace) {
        throw new Error(`Workspace not found: ${this.session.config.workspaceId}`);
      }

      this.standaloneSession = null;
      this.standaloneExecutor = null;
      this.commandCwd = this.workspace.directory;

      this.session = await this.resolveWorkspaceSessionMode(this.session, this.workspace);
      await sshSessionManager.markStatus(this.sessionId, "connecting");

      spawnConfig = buildSshSpawnConfig(this.workspace, this.session);
    }
    const proc = spawn(spawnConfig.command, spawnConfig.args, {
      env: spawnConfig.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");

    this.closePromise = new Promise((resolve) => {
      proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        void (async () => {
          this.flushBufferedOutput();
          this.ready = false;
          this.proc = null;
          const skipStatusUpdate = this.skipCloseStatusUpdate;
          this.skipCloseStatusUpdate = false;
          const nextStatus = this.closing ? "disconnected" : code === 0 ? "disconnected" : "failed";
          const error = !this.closing && code !== 0
            ? `SSH terminal exited with code ${String(code)}${signal ? ` (${signal})` : ""}`
            : undefined;
          if (error) {
            this.startupError = error;
          }

          try {
            if (!skipStatusUpdate) {
              await this.runWithBridgeUser(() => this.markStatus(nextStatus, error));
            }
          } catch (statusError) {
            log.error("Failed to update SSH session status after terminal close", {
              sessionId: this.sessionId,
              error: String(statusError),
            });
          } finally {
            this.options.onExit?.(code, signal);
            this.closePromise = null;
            resolve();
          }
        })();
      });
    });

    proc.stdout.on("data", (chunk: string) => {
      this.handleOutputChunk(chunk, "stdout");
    });
    proc.stderr.on("data", (chunk: string) => {
      this.handleOutputChunk(chunk, "stderr");
    });
    proc.on("error", (error: Error) => {
      this.startupError = String(error);
      this.options.onError?.(error);
    });

    try {
      await this.waitForRemoteSessionReady();
      this.ready = true;
      await this.markStatus("connected");
    } catch (error) {
      const startupError = error instanceof Error ? error : new Error(String(error));
      this.ready = false;
      this.startupError = startupError.message;
      log.error("SSH terminal failed before becoming ready", {
        sessionId: this.sessionId,
        trackedSessionId: this.getTrackedSessionId(),
        connectionMode: this.getConnectionMode(),
        error: startupError.message,
      });

      if (!this.closing) {
        this.options.onError?.(startupError);
        await this.markStatus("failed", startupError.message);
        this.skipCloseStatusUpdate = true;
      }

      if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) {
        this.proc.kill("SIGTERM");
      }
      await this.waitForClose();
      throw startupError;
    }
  }

  sendInput(data: string): void {
    if (!this.proc?.stdin.writable) {
      throw new Error("SSH terminal is not connected");
    }
    this.proc.stdin.write(data);
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (!this.session && !this.standaloneSession) {
      throw new Error("SSH terminal is not connected");
    }
    await this.ensureReady();
    const normalizedCols = Math.max(2, Math.floor(cols));
    const normalizedRows = Math.max(1, Math.floor(rows));
    const executor = await this.getCommandExecutor();
    const resizeCommand = this.getConnectionMode() === "direct"
      ? buildDirectResizeCommand(this.getTrackedSessionId(), normalizedCols, normalizedRows)
      : buildPersistentSessionResizeCommand(this.getTrackedSessionId(), normalizedCols, normalizedRows);
    const result = await executor.exec("bash", [
      "-lc",
      resizeCommand,
    ], {
      cwd: this.commandCwd,
      timeout: DEFAULT_SSH_TERMINAL_COMMAND_TIMEOUT_MS,
    });
    if (!result.success) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "Failed to resize SSH terminal");
    }
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) {
      return;
    }
    if (!this.connectPromise) {
      throw new Error("SSH terminal is not connected");
    }
    await this.connectPromise;
  }

  private handleOutputChunk(chunk: string, stream: "stdout" | "stderr"): void {
    const buffer = (stream === "stdout" ? this.stdoutBuffer : this.stderrBuffer) + chunk;
    const parsed = extractClipboardSequences(buffer);
    let visibleOutput = parsed.visibleOutput;
    let remainder = parsed.remainder;
    const remainderBytes = Buffer.byteLength(remainder, "utf8");
    if (remainder.length > 0 && remainderBytes > MAX_PENDING_OSC_SEQUENCE_BYTES) {
      log.warn("Flushing oversized OSC 52 buffer", {
        sessionId: this.sessionId,
        stream,
        bufferedBytes: remainderBytes,
        limitBytes: MAX_PENDING_OSC_SEQUENCE_BYTES,
      });
      visibleOutput += remainder;
      remainder = "";
    }
    if (stream === "stdout") {
      this.stdoutBuffer = remainder;
    } else {
      this.stderrBuffer = remainder;
    }
    if (visibleOutput.length > 0) {
      this.options.onOutput(visibleOutput);
    }
    for (const clipboardText of parsed.clipboardCopies) {
      this.options.onClipboardCopy?.(clipboardText);
    }
  }

  private flushBufferedOutput(): void {
    if (this.stdoutBuffer.length > 0) {
      this.options.onOutput(this.stdoutBuffer);
      this.stdoutBuffer = "";
    }
    if (this.stderrBuffer.length > 0) {
      this.options.onOutput(this.stderrBuffer);
      this.stderrBuffer = "";
    }
  }

  private async waitForRemoteSessionReady(): Promise<void> {
    if (!this.session && !this.standaloneSession) {
      throw new Error("SSH terminal is not connected");
    }

    const executor = await this.getCommandExecutor();
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? DEFAULT_SESSION_READY_TIMEOUT_MS);
    if (this.getConnectionMode() === "direct") {
      while (Date.now() < deadline) {
        if (!this.proc) {
          throw new Error("SSH terminal is not connected");
        }
        if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
          throw new Error(this.startupError ?? "SSH terminal exited before the direct session was ready");
        }

        const result = await executor.exec("bash", [
          "-lc",
          buildDirectReadyCommand(this.getTrackedSessionId()),
        ], {
          cwd: this.commandCwd,
          timeout: this.getReadyProbeTimeout(deadline),
          logFailures: false,
        });
        if (result.success) {
          return;
        }

        await Bun.sleep(SESSION_READY_POLL_INTERVAL_MS);
      }

      throw new Error("Timed out waiting for the direct SSH shell to become ready");
    }

    while (Date.now() < deadline) {
      if (!this.proc) {
        throw new Error("SSH terminal is not connected");
      }
      if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
        throw new Error(this.startupError ?? "SSH terminal exited before the persistent SSH session was ready");
      }

      const result = await executor.exec("bash", [
        "-lc",
        buildPersistentSessionReadyCommand({
          config: {
            id: this.getTrackedSessionId(),
            remoteSessionName: this.getRemoteSessionName(),
          },
        }),
      ], {
        cwd: this.commandCwd,
        timeout: this.getReadyProbeTimeout(deadline),
        logFailures: false,
      });
      if (result.success) {
        return;
      }

      await Bun.sleep(SESSION_READY_POLL_INTERVAL_MS);
    }

    throw new Error(`Timed out waiting for persistent SSH session ${this.getRemoteSessionName()} to become ready`);
  }

  private getReadyProbeTimeout(deadline: number): number {
    const remainingMs = Math.max(0, deadline - Date.now());
    return Math.min(MAX_SESSION_READY_PROBE_TIMEOUT_MS, remainingMs);
  }

  private async waitForClose(): Promise<void> {
    if (this.closePromise) {
      await this.closePromise;
    }
  }

  async dispose(): Promise<void> {
    this.closing = true;
    this.ready = false;
    if (!this.proc) {
      this.connectPromise = null;
      return;
    }

    const proc = this.proc;
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGTERM");
    }
    await this.waitForClose();
    this.connectPromise = null;
    log.debug("Disposed SSH terminal bridge", { sessionId: this.sessionId });
  }

  private async markStatus(status: "connecting" | "connected" | "disconnected" | "failed", error?: string): Promise<void> {
    if (this.connectOptions.sessionKind === "standalone") {
      await sshServerManager.markStatus(this.sessionId, status, error);
      return;
    }

    await sshSessionManager.markStatus(this.sessionId, status, error);
  }

  private runWithBridgeUser<T>(callback: () => T): T {
    if (!this.user) {
      throw new Error("Current user context is required");
    }
    return runWithCurrentUser(this.user, callback);
  }

  private async getCommandExecutor(): Promise<CommandExecutor> {
    if (this.connectOptions.sessionKind === "standalone") {
      if (!this.standaloneExecutor) {
        throw new Error("SSH terminal is not connected");
      }
      return this.standaloneExecutor;
    }
    if (!this.workspace) {
      throw new Error("SSH terminal is not connected");
    }
    return await backendManager.getCommandExecutorAsync(this.workspace.id, this.workspace.directory);
  }

  private getConnectionMode(): SshConnectionMode {
    if (this.connectOptions.sessionKind === "standalone") {
      if (!this.standaloneSession) {
        throw new Error("SSH terminal is not connected");
      }
      return getEffectiveSshConnectionMode(this.standaloneSession);
    }
    if (!this.session) {
      throw new Error("SSH terminal is not connected");
    }
    return getEffectiveSshConnectionMode(this.session);
  }

  private async resolveWorkspaceSessionMode(session: SshSession, workspace: Workspace): Promise<SshSession> {
    const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
    return await this.resolvePersistentBackendMode(
      session,
      executor,
      async (options) => await sshSessionManager.updateRuntimeConnectionState(session.config.id, options),
    );
  }

  private async resolveStandaloneSessionMode(
    session: SshServerSession,
    executor: CommandExecutor,
  ): Promise<SshServerSession> {
    return await this.resolvePersistentBackendMode(
      session,
      executor,
      async (options) => await sshServerManager.updateRuntimeConnectionState(session.config.id, options),
    );
  }

  private async resolvePersistentBackendMode<TSession extends {
    config: { id: string; connectionMode: SshConnectionMode };
    state: { runtimeConnectionMode?: SshConnectionMode; notice?: string };
  }>(
    session: TSession,
    executor: CommandExecutor,
    updateRuntimeState: (options: { runtimeConnectionMode?: SshConnectionMode; notice?: string }) => Promise<TSession>,
  ): Promise<TSession> {
    if (session.config.connectionMode === "direct") {
      if (session.state.runtimeConnectionMode || session.state.notice) {
        return await updateRuntimeState({});
      }
      return session;
    }

    const result = await executor.exec("bash", ["-lc", buildPersistentSessionBackendProbeCommand()], {
      cwd: "/",
      timeout: DEFAULT_SSH_TERMINAL_COMMAND_TIMEOUT_MS,
    });
    if (result.success) {
      if (session.state.runtimeConnectionMode || session.state.notice) {
        return await updateRuntimeState({});
      }
      return session;
    }

    if (!this.isMissingPersistentBackendResult(result.exitCode)) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new Error(detail || "Failed to verify persistent SSH backend availability");
    }

    const notice = buildPersistentSessionBackendInstallHint();
    log.warn("Persistent SSH backend unavailable, falling back to direct mode", {
      sessionId: session.config.id,
      exitCode: result.exitCode,
      detail: result.stderr.trim() || result.stdout.trim(),
    });
    return await updateRuntimeState({
      runtimeConnectionMode: "direct",
      notice,
    });
  }

  private isMissingPersistentBackendResult(exitCode: number): boolean {
    return exitCode === 1 || exitCode === 127;
  }

  private getTrackedSessionId(): string {
    if (this.connectOptions.sessionKind === "standalone") {
      if (!this.standaloneSession) {
        throw new Error("SSH terminal is not connected");
      }
      return this.standaloneSession.config.id;
    }
    if (!this.session) {
      throw new Error("SSH terminal is not connected");
    }
    return this.session.config.id;
  }

  private getRemoteSessionName(): string {
    if (this.connectOptions.sessionKind === "standalone") {
      if (!this.standaloneSession) {
        throw new Error("SSH terminal is not connected");
      }
      return this.standaloneSession.config.remoteSessionName;
    }
    if (!this.session) {
      throw new Error("SSH terminal is not connected");
    }
    return this.session.config.remoteSessionName;
  }
}
