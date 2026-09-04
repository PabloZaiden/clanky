/**
 * SshTerminalBridge class — bridges WebSocket terminal sessions over SSH.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import type { CommandExecutor } from "../command-executor";
import type {
  SshServerSession,
  TerminalConnectionMode,
  Workspace,
  WorkspaceTerminalSession,
} from "@/shared";
import { getWorkspace } from "../../persistence/workspaces";
import {
  buildPersistentSessionBackendInstallHint,
  buildPersistentSessionBackendProbeCommand,
  buildPersistentSessionReadyCommand,
  hasPersistentSession,
  buildPersistentSessionResizeCommand,
  PERSISTENT_SESSION_ATTACH_UNAVAILABLE_EXIT_CODE,
} from "../ssh-persistent-session";
import { sshServerManager } from "../ssh-server-manager";
import { terminalSessionManager } from "../terminal-session-manager";
import { createLogger } from "@pablozaiden/webapp/server";
import { backendManager } from "../backend-manager";
import { getEffectiveTerminalConnectionMode } from "../../utils";
import type { SshTerminalBridgeOptions, SshTerminalBridgeConnectOptions } from "./types";
import {
  SESSION_READY_POLL_INTERVAL_MS,
  DEFAULT_SESSION_READY_TIMEOUT_MS,
  MAX_SESSION_READY_PROBE_TIMEOUT_MS,
  DEFAULT_SSH_TERMINAL_COMMAND_TIMEOUT_MS,
  MAX_PENDING_OSC_SEQUENCE_BYTES,
} from "./constants";
import {
  buildWorkspaceSshSpawnConfig,
  buildStandaloneSshSpawnConfig,
  buildExecutionHostSshSpawnConfig,
  buildDirectReadyCommand,
  buildDirectResizeCommand,
} from "./command-builders";
import { extractClipboardSequences } from "./osc52";
import { requireCurrentUser, runWithCurrentUser } from "../user-context";
import { managedContextIdentityResolver } from "../managed-context-identity";
import { managedCredentialService, type ManagedRuntimeCredential } from "../managed-credential-service";
import { buildManagedContextEnvironment } from "../managed-context-environment";
import { DomainError } from "../domain-error";
import { isWorkspaceTerminalAttachmentBlocked } from "../workspace-terminal-attachment-registry";

const log = createLogger("core:ssh-terminal-bridge");

export class SshTerminalBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private session: WorkspaceTerminalSession | null = null;
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
  private lastProcessExitCode: number | null = null;
  private suppressNextExitNotification = false;
  private disposed = false;

  constructor(
    private readonly sessionId: string,
    private readonly options: SshTerminalBridgeOptions,
    private readonly connectOptions: SshTerminalBridgeConnectOptions,
  ) {}

  async connect(): Promise<void> {
    this.assertNotDisposed();
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
    this.assertNotDisposed();
    this.user = requireCurrentUser();
    this.closing = false;
    this.ready = false;
    this.skipCloseStatusUpdate = false;
    this.startupError = undefined;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.lastProcessExitCode = null;
    this.suppressNextExitNotification = false;

    this.session = this.connectOptions.sessionKind === "terminal"
      ? await terminalSessionManager.getSession(this.sessionId)
      : null;
    this.assertNotDisposed();
    let managedCredential: ManagedRuntimeCredential | undefined;
    let spawnConfig: { command: string; args: string[]; env: NodeJS.ProcessEnv };
    let persistentRuntimeAttachOnly = false;
    if (this.connectOptions.sessionKind === "standalone") {
      const connection = await sshServerManager.getTerminalConnection(
        this.sessionId,
        this.connectOptions.credentialToken ?? "",
      );
      this.assertNotDisposed();
      this.session = null;
      this.workspace = null;
      this.standaloneSession = await this.resolveStandaloneSessionMode(connection.session, connection.executor);
      this.assertNotDisposed();
      this.standaloneExecutor = connection.executor;
      this.commandCwd = "/";
      await sshServerManager.markStatus(this.sessionId, "connecting");
      this.assertNotDisposed();
      spawnConfig = buildStandaloneSshSpawnConfig(connection.target, this.standaloneSession);
    } else {
      if (!this.session) {
        throw new Error(`Terminal session not found: ${this.sessionId}`);
      }

      if (!this.session.config.workspaceId) {
        const host = this.session.config.executionHostBinding?.host;
        if (!host || host.kind !== "ssh") {
          throw new DomainError(
            "terminal_execution_host_invalid",
            "The terminal session is not bound to an SSH execution host.",
          );
        }
        const connection = await sshServerManager.getExecutionHostTerminalConnection(
          host.serverId,
          this.connectOptions.credentialToken ?? "",
        );
        this.workspace = null;
        this.standaloneSession = null;
        this.standaloneExecutor = connection.executor;
        this.commandCwd = this.session.config.directory;
        this.session = await this.resolvePersistentBackendMode(
          this.session,
          connection.executor,
          async (options) => await terminalSessionManager.updateRuntimeConnectionState(
            this.sessionId,
            options,
          ),
        );
        await this.markStatus("connecting");
        spawnConfig = buildExecutionHostSshSpawnConfig(connection.target, this.session);
        await this.launchSshProcess(spawnConfig, false);
        return;
      }
      this.workspace = await getWorkspace(this.session.config.workspaceId);
      this.assertNotDisposed();
      if (!this.workspace) {
        throw new Error(`Workspace not found: ${this.session.config.workspaceId}`);
      }

      this.standaloneSession = null;
      this.standaloneExecutor = null;
      this.commandCwd = this.workspace.directory;

      this.session = await this.resolveWorkspaceSessionMode(this.session, this.workspace);
      this.assertNotDisposed();
      await this.markStatus("connecting");
      this.assertNotDisposed();

      const runtime = await this.getWorkspaceRuntimeEnvironment(this.workspace, this.session);
      this.assertNotDisposed();
      managedCredential = runtime.credential;
      persistentRuntimeAttachOnly = runtime.persistentRuntimeExists;
      try {
        spawnConfig = buildWorkspaceSshSpawnConfig(
          this.workspace,
          this.session,
          runtime.environment,
          !runtime.persistentRuntimeExists,
        );
      } catch (error) {
        await managedCredentialService.cleanupFailedLaunch(managedCredential, error);
        throw error;
      }
    }

    while (true) {
      try {
        await this.launchSshProcess(spawnConfig, persistentRuntimeAttachOnly);
        return;
      } catch (error) {
        if (
          !this.disposed
          &&
          persistentRuntimeAttachOnly
          && this.lastProcessExitCode === PERSISTENT_SESSION_ATTACH_UNAVAILABLE_EXIT_CODE
          && this.workspace
          && this.session
        ) {
          persistentRuntimeAttachOnly = false;
          try {
            const identity = await managedContextIdentityResolver.forTerminalSession(
              this.session.config.id,
              this.workspace.id,
            );
            managedCredential = await managedCredentialService.ensureCredentialForRuntime(identity, "recreate");
            spawnConfig = buildWorkspaceSshSpawnConfig(
              this.workspace,
              this.session,
              buildManagedContextEnvironment(managedCredential),
              true,
            );
            continue;
          } catch (retryError) {
            error = retryError;
          }
        }

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
        if (managedCredential) {
          await managedCredentialService.cleanupFailedLaunch(managedCredential, startupError);
        }
        throw startupError;
      }
    }
  }

  private async launchSshProcess(
    spawnConfig: { command: string; args: string[]; env: NodeJS.ProcessEnv; startupStdin?: string },
    suppressExitNotificationOnFailure: boolean,
  ): Promise<void> {
    this.assertNotDisposed();
    this.lastProcessExitCode = null;
    this.startupError = undefined;
    this.skipCloseStatusUpdate = false;

    const proc = spawn(spawnConfig.command, spawnConfig.args, {
      env: spawnConfig.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    if (spawnConfig.startupStdin) {
      proc.stdin.write(spawnConfig.startupStdin);
    }

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");

    this.closePromise = new Promise((resolve) => {
      proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        void (async () => {
          this.flushBufferedOutput();
          this.ready = false;
          this.proc = null;
          this.lastProcessExitCode = code;
          const skipStatusUpdate = this.skipCloseStatusUpdate;
          const suppressExitNotification = this.suppressNextExitNotification
            && code === PERSISTENT_SESSION_ATTACH_UNAVAILABLE_EXIT_CODE;
          this.skipCloseStatusUpdate = false;
          this.suppressNextExitNotification = false;
          const nextStatus = this.closing ? "disconnected" : code === 0 ? "disconnected" : "failed";
          const error = !this.closing && code !== 0
            ? `SSH terminal exited with code ${String(code)}${signal ? ` (${signal})` : ""}`
            : undefined;
          if (error) {
            this.startupError = error;
          }

          try {
            if (
              !skipStatusUpdate
              && !(
                this.connectOptions.sessionKind === "terminal"
                && isWorkspaceTerminalAttachmentBlocked(this.sessionId))
            ) {
              await this.runWithBridgeUser(() => this.markStatus(nextStatus, error));
            }
          } catch (statusError) {
            log.error("Failed to update terminal status after SSH terminal close", {
              sessionId: this.sessionId,
              error: String(statusError),
            });
          } finally {
            if (!suppressExitNotification) {
              this.options.onExit?.(code, signal);
            }
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
      this.assertNotDisposed();
      this.ready = true;
      await this.markStatus("connected");
      this.assertNotDisposed();
    } catch (error) {
      const startupError = error instanceof Error ? error : new Error(String(error));
      this.ready = false;
      this.startupError = startupError.message;
      if (suppressExitNotificationOnFailure) {
        this.suppressNextExitNotification = true;
      }
      this.skipCloseStatusUpdate = true;
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
    this.assertNotDisposed();
    if (!this.session && !this.standaloneSession) {
      throw new Error("SSH terminal is not connected");
    }

    const executor = await this.getCommandExecutor();
    this.assertNotDisposed();
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? DEFAULT_SESSION_READY_TIMEOUT_MS);
    if (this.getConnectionMode() === "direct") {
      while (Date.now() < deadline) {
        this.assertNotDisposed();
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

        this.assertNotDisposed();
        await Bun.sleep(SESSION_READY_POLL_INTERVAL_MS);
      }

      throw new Error("Timed out waiting for the direct SSH shell to become ready");
    }

    while (Date.now() < deadline) {
      this.assertNotDisposed();
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

      this.assertNotDisposed();
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
    this.disposed = true;
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
    if (
      this.connectOptions.sessionKind === "terminal"
      && isWorkspaceTerminalAttachmentBlocked(this.sessionId)
    ) {
      return;
    }
    if (this.connectOptions.sessionKind === "standalone") {
      await sshServerManager.markStatus(this.sessionId, status, error);
      return;
    }
    if (this.connectOptions.sessionKind === "terminal") {
      await terminalSessionManager.markStatus(this.sessionId, status, error);
      return;
    }
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
      if (this.standaloneExecutor) {
        return this.standaloneExecutor;
      }
      return this.standaloneExecutor;
    }
    if (!this.workspace) {
      throw new Error("SSH terminal is not connected");
    }
    return await backendManager.getCommandExecutorAsync(this.workspace.id, this.workspace.directory);
  }

  private getConnectionMode(): TerminalConnectionMode {
    if (this.connectOptions.sessionKind === "standalone") {
      if (!this.standaloneSession) {
        throw new Error("SSH terminal is not connected");
      }
      return getEffectiveTerminalConnectionMode(this.standaloneSession);
    }
    if (!this.session) {
      throw new Error("SSH terminal is not connected");
    }
    return getEffectiveTerminalConnectionMode(this.session);
  }

  private async resolveWorkspaceSessionMode(
    session: WorkspaceTerminalSession,
    workspace: Workspace,
  ): Promise<WorkspaceTerminalSession> {
    const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
    return await this.resolvePersistentBackendMode(
      session,
      executor,
      async (options) => await terminalSessionManager.updateRuntimeConnectionState(session.config.id, options),
    );
  }

  private async getWorkspaceRuntimeEnvironment(
    workspace: Workspace,
    session: WorkspaceTerminalSession,
  ): Promise<{
    environment?: Record<string, string>;
    credential?: ManagedRuntimeCredential;
    persistentRuntimeExists: boolean;
  }> {
    const identity = await managedContextIdentityResolver.forTerminalSession(session.config.id, workspace.id);
    const persistentRuntimeExists = getEffectiveTerminalConnectionMode(session) === "dtach"
      && await this.hasPersistentRuntime(workspace, session);
    if (persistentRuntimeExists) {
      return { persistentRuntimeExists };
    }

    const credential = await managedCredentialService.ensureCredentialForRuntime(
      identity,
      "recreate",
    );
    return {
      credential,
      environment: buildManagedContextEnvironment(credential),
      persistentRuntimeExists: false,
    };
  }

  private async hasPersistentRuntime(workspace: Workspace, session: WorkspaceTerminalSession): Promise<boolean> {
    const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
    return await hasPersistentSession(
      executor,
      {
        config: {
          id: session.config.id,
          remoteSessionName: session.config.remoteSessionName,
        },
      },
      workspace.directory,
      DEFAULT_SSH_TERMINAL_COMMAND_TIMEOUT_MS,
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
    config: { id: string; connectionMode: TerminalConnectionMode };
    state: { runtimeConnectionMode?: TerminalConnectionMode; notice?: string };
  }>(
    session: TSession,
    executor: CommandExecutor,
    updateRuntimeState: (options: { runtimeConnectionMode?: TerminalConnectionMode; notice?: string }) => Promise<TSession>,
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
    this.assertNotDisposed();
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

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new DomainError("terminal_connection_closed", "The terminal connection is closed.");
    }
  }
}
