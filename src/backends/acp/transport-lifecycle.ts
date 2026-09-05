/**
 * Process and transport lifecycle service for the ACP backend.
 *
 * Sole owner of the ACP subprocess, stdout/stderr readers, recent diagnostic
 * output buffering, process-exit observation, and graceful/forced shutdown. It
 * exposes a narrow {@link RpcTransport} to the RPC client for writing wire
 * messages and forwards parsed inbound messages to a configured sink. It does
 * not own JSON-RPC request bookkeeping or any session behavior.
 */

import { isRemoteOnlyMode } from "../../core/config";
import { log } from "@pablozaiden/webapp/server";
import {
  buildProviderSpawnEnvironment,
  getProviderAcpCommand,
} from "../../core/agent-runtime-command";
import { sshConnectionGate, type SshConnectionGate } from "../../core/ssh-connection-gate";
import {
  buildSshConnectionKey,
  getSshReliabilityPolicy,
  type SshReliabilityPolicy,
} from "../../core/ssh-reliability-policy";
import {
  DEFAULT_SERVER_AGENT_PROVIDER,
  type AgentProvider,
} from "@/shared/settings";
import type { BackendConnectionConfig, ConnectionInfo } from "../types";

import {
  sanitizeSpawnArgsForLogging,
  getProcessExitHint,
  isSshAuthenticationFailureExit,
} from "./process-utils";
import {
  AcpError,
  createAcpConnectionAbortedError,
  createAcpConnectionTimeoutError,
  createAcpProcessError,
  getAcpErrorMessage,
} from "./errors";
import {
  MAX_RECENT_PROCESS_LINES,
  type AcpAuthenticationMode,
  type AcpProcessExit,
  type AcpTransportStage,
} from "./types";
import { AcpProcess } from "./acp-process";
import type { JsonRpcMessage } from "./types";
import type {
  AcpTransportClosedEvent,
  AcpTransportLifecycle,
  AcpTransportSession,
  RpcPendingController,
  RpcRequester,
  RpcTransport,
} from "./contracts";

export class LocalAcpTransportLifecycle implements AcpTransportLifecycle {
  private readonly reliabilityPolicy: SshReliabilityPolicy;
  private readonly connectionGate: SshConnectionGate;
  private process: AcpProcess | null = null;
  private connected = false;
  private directory = "";
  private provider: AgentProvider | null = null;
  private connectionInfo: ConnectionInfo | null = null;
  private session: AcpTransportSession | null = null;
  private stage: AcpTransportStage = "spawn";

  /** Recent non-JSON ACP process output lines for diagnostics. */
  private recentProcessLines: string[] = [];

  private requester: (RpcRequester & RpcPendingController) | null = null;
  private onMessage: ((message: JsonRpcMessage) => void) | null = null;
  private onTransportClosed: ((event: AcpTransportClosedEvent) => void) | null = null;

  constructor(options: {
    reliabilityPolicy?: SshReliabilityPolicy;
    connectionGate?: SshConnectionGate;
  } = {}) {
    this.reliabilityPolicy = options.reliabilityPolicy ?? getSshReliabilityPolicy();
    this.connectionGate = options.connectionGate ?? sshConnectionGate;
  }

  /** Narrow transport exposed to the RPC client for writing wire messages. */
  readonly transport: RpcTransport = {
    write: (message: JsonRpcMessage): void => this.writeRpcMessage(message),
    isWritable: (): boolean => {
      const process = this.process;
      return process?.isWritable() ?? false;
    },
  };

  /** Wire the parsed-message sink after both collaborators are constructed. */
  setMessageHandler(handler: (message: JsonRpcMessage) => void): void {
    this.onMessage = handler;
  }

  setTransportClosedHandler(handler: (event: AcpTransportClosedEvent) => void): void {
    this.onTransportClosed = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }

  hasProcess(): boolean {
    return this.process !== null;
  }

  getProcess(): Bun.Subprocess | null {
    return this.process?.getChild() ?? null;
  }

  getDirectory(): string {
    return this.directory;
  }

  getProvider(): AgentProvider | null {
    return this.provider;
  }

  getConnectionInfo(): ConnectionInfo | null {
    return this.connectionInfo;
  }

  getSession(): AcpTransportSession | null {
    return this.session;
  }

  ensureConnected(): void {
    if (!this.connected || !this.process) {
      throw new Error("Not connected. Call connect() first.");
    }
  }

  /** Connect to an ACP-capable agent by spawning the configured CLI. */
  async connect(
    config: BackendConnectionConfig,
    signal: AbortSignal | undefined,
    requester: RpcRequester & RpcPendingController,
  ): Promise<unknown> {
    if (this.connected) {
      throw new Error("Already connected. Call disconnect() first.");
    }

    this.directory = config.directory;
    this.provider = config.provider ?? DEFAULT_SERVER_AGENT_PROVIDER;
    this.stage = "spawn";
    this.session = {
      id: crypto.randomUUID(),
      kind: "local",
    };
    this.requester = requester;
    log.debug("[AcpBackend] connect requested", {
      transport: config.transport,
      provider: config.provider,
      directory: config.directory,
    });

    try {
      if (config.mesh) {
        throw new AcpError(
          "acp_transport_unavailable",
          "Remote stdio requires MeshAcpTransport; local ACP fallback is disabled.",
          { details: config.mesh },
        );
      }
      if (config.mode !== "spawn") {
        throw new Error("Connect mode is not supported by ACP runtime. Use stdio or ssh transport.");
      }

      if (isRemoteOnlyMode() && config.transport !== "ssh") {
        throw new Error(
          "Local stdio transport is disabled. CLANKY_REMOTE_ONLY environment variable is set. " +
          "Only ssh transport is allowed.",
        );
      }

      this.connected = true;
      const connectionAbort = this.createConnectionAbortContext(config, signal);
      try {
        return await this.connectSpawn(config, connectionAbort.signal, requester);
      } finally {
        connectionAbort.dispose();
      }
    } catch (error) {
      const process = this.detachForShutdown();
      await this.terminateProcess(process);
      throw error;
    }
  }

  private async connectSpawn(
    config: BackendConnectionConfig,
    signal: AbortSignal | undefined,
    requester: RpcRequester & RpcPendingController,
  ): Promise<unknown> {
    const providerCommand = getProviderAcpCommand(
      config.provider ?? DEFAULT_SERVER_AGENT_PROVIDER,
      config.transport,
    );
    const command = config.command ?? providerCommand.command;
    const args = config.args ?? providerCommand.args;
    const spawnEnv = config.transport === "ssh"
      ? config.env
      : buildProviderSpawnEnvironment(providerCommand, process.env, config.env);
    const logArgs = sanitizeSpawnArgsForLogging(command, args);
    const spawnCwd = config.transport === "ssh" ? "/" : config.directory;
    this.recentProcessLines = [];
    log.debug("[AcpBackend] Spawning ACP runtime", {
      command,
      args: logArgs,
      directory: config.directory,
      spawnCwd,
      transport: config.transport,
      provider: config.provider,
    });

    const maxAttempts = 1;
    let initializeResult: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.stage = "spawn";
      this.throwIfAborted(signal, config);
      this.recentProcessLines = [];
      let processHandle: AcpProcess | null = null;
      let releaseConnectionGate: () => void = () => {};
      try {
        if (config.transport === "ssh") {
          releaseConnectionGate = await this.connectionGate.acquire(
            buildSshConnectionKey(config),
            signal,
          );
        }

        try {
          const spawned = await AcpProcess.spawn({
            command,
            args,
            cwd: spawnCwd,
            env: spawnEnv,
            authenticationMode: this.getAuthenticationMode(config),
            onLine: (source, line) => {
              if (processHandle) {
                this.handleRpcLine(processHandle, line, source);
              }
            },
            onExit: (exit) => {
              if (processHandle) {
                this.handleProcessExit(processHandle, command, exit, config, attempt);
              }
            },
            onStreamError: (source, error) => {
              log.warn(`[AcpBackend] ACP ${source} stream ended with error`, {
                error: String(error),
              });
            },
          });
          processHandle = spawned;
        } catch (error) {
          throw new AcpError(
            "acp_process_failed",
            `Failed to spawn ACP process (${command}) in cwd '${spawnCwd}': ${getAcpErrorMessage(error)}`,
            {
              cause: error,
              details: this.getConnectionDetails(config, attempt),
            },
          );
        }

        const process = processHandle;
        if (!process) {
          throw new AcpError(
            "acp_process_failed",
            "ACP process was not created.",
            { details: this.getConnectionDetails(config, attempt) },
          );
        }
        this.process = process;
        this.stage = "initialize";
        this.throwIfAborted(signal, config);
        if (config.startupStdin) {
          process.write(config.startupStdin);
        }
        process.start();
        if (process.exitCode !== null) {
          throw createAcpProcessError(
            `ACP process exited with code ${process.exitCode}`,
            {
              command,
              exitCode: process.exitCode,
              signalCode: process.signalCode,
              transport: config.transport,
              authenticationMode: this.getAuthenticationMode(config),
              authenticationFailure: this.isAuthenticationFailure(command, process.exitCode, config),
              stage: this.stage,
              attempt,
              target: this.getTargetDetails(config),
              initializationCompleted: false,
            },
          );
        }

        initializeResult = await raceWithAbort(
          requester.sendRequest("initialize", {
            protocolVersion: 1,
            clientInfo: {
              name: "clanky",
              version: "0.0.0",
            },
          }),
          signal,
          () => this.getAbortError(signal, config),
        );
        this.stage = "ready";
        this.throwIfAbortedAfterInitialize(signal, config);
        this.stage = "runtime";
      } catch (error) {
        const failure = error instanceof AcpError
          ? error
          : new AcpError(
              "acp_process_failed",
              `Failed to initialize ACP process (${command}): ${getAcpErrorMessage(error)}`,
              {
                cause: error,
                details: this.getConnectionDetails(config, attempt),
              },
            );
        await this.terminateProcess(processHandle);
        if (this.process === processHandle) {
          this.process = null;
        }
        requester.rejectPending(failure);
        requester.clearPending();
        throw failure;
      } finally {
        releaseConnectionGate();
      }
    }
    log.debug("[AcpBackend] ACP runtime initialized", { command });

    this.connectionInfo = {
      baseUrl: `acp://stdio/${command}`,
      authHeaders: {},
    };
    return initializeResult;
  }

  private throwIfAborted(signal: AbortSignal | undefined, config: BackendConnectionConfig): void {
    if (signal?.aborted) {
      throw this.getAbortError(signal, config);
    }
  }

  private throwIfAbortedAfterInitialize(
    signal: AbortSignal | undefined,
    config: BackendConnectionConfig,
  ): void {
    if (!signal?.aborted) {
      return;
    }
    throw this.getAbortError(signal, config);
  }

  /** Reset connection metadata and diagnostics; returns the detached process. */
  detachForShutdown(): AcpProcess | null {
    const process = this.process;
    this.process = null;
    this.connected = false;
    this.directory = "";
    this.provider = null;
    this.connectionInfo = null;
    this.session = null;
    this.stage = "spawn";
    this.recentProcessLines = [];
    this.requester = null;
    return process;
  }

  async disconnect(): Promise<void> {
    const process = this.detachForShutdown();
    await this.terminateProcess(process);
  }

  private pushProcessLine(line: string): void {
    this.recentProcessLines.push(line);
    if (this.recentProcessLines.length > MAX_RECENT_PROCESS_LINES) {
      this.recentProcessLines.shift();
    }
  }

  private handleProcessExit(
    process: AcpProcess,
    command: string,
    exit: AcpProcessExit,
    config: BackendConnectionConfig,
    attempt: number,
  ): void {
    if (this.process !== process || !this.connected) {
      return;
    }
    const hint = getProcessExitHint(command, exit.exitCode);
    const details = this.recentProcessLines.slice(-5).join(" | ");
    const parts = [`ACP process exited with code ${exit.exitCode}`];
    if (details.length > 0) {
      parts.push(details);
    }
    if (hint) {
      parts.push(hint);
    }
    const reason = parts.join(": ");
    const error = createAcpProcessError(reason, {
      command,
      exitCode: exit.exitCode,
      signalCode: exit.signalCode,
      transport: config.transport,
      authenticationMode: this.getAuthenticationMode(config),
      authenticationFailure: this.isAuthenticationFailure(command, exit.exitCode, config),
      stage: this.stage,
      attempt,
      target: this.getTargetDetails(config),
      initializationCompleted: this.stage === "runtime",
    });
    log.error("[AcpBackend] ACP process exited", {
      command,
      exitCode: exit.exitCode,
      signalCode: exit.signalCode,
      transport: config.transport ?? "stdio",
      stage: this.stage,
      attempt,
      target: this.getTargetDetails(config),
      initializationCompleted: this.stage === "runtime",
      authenticationMode: this.getAuthenticationMode(config),
    });
    const requester = this.requester;
    const initializationInProgress = this.stage === "spawn" || this.stage === "initialize";
    requester?.rejectPending(error);
    this.process = null;
    if (initializationInProgress) {
      return;
    }

    const session = this.session;
    this.connected = false;
    this.directory = "";
    this.provider = null;
    this.connectionInfo = null;
    this.session = null;
    this.requester = null;
    if (session) {
      this.onTransportClosed?.({
        session,
        reason: "process-exit",
        error,
      });
    }
  }

  private handleRpcLine(process: AcpProcess, line: string, source: "stdout" | "stderr"): void {
    if (this.process !== process || !this.connected) {
      return;
    }

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.pushProcessLine(`[${source}] ${line}`);
      if (source === "stderr") {
        log.debug(`[AcpBackend] ACP stderr: ${line}`);
      } else {
        log.trace(`[AcpBackend] Non-JSON stdout: ${line}`);
      }
      return;
    }

    this.onMessage?.(message);
  }

  async terminateProcess(process: AcpProcess | null): Promise<void> {
    await process?.stop();
  }

  private writeRpcMessage(message: JsonRpcMessage): void {
    const process = this.process;
    if (!process) {
      throw new Error("ACP process is not available");
    }

    log.trace("[AcpBackend] Writing RPC message", {
      id: message.id,
      method: message.method,
      params: message.params,
    });

    process.write(`${JSON.stringify(message)}\n`);
  }

  private getTargetDetails(config: BackendConnectionConfig): {
    hostname?: string;
    port?: number;
    username?: string;
  } | undefined {
    if (config.transport !== "ssh") {
      return undefined;
    }
    return {
      ...(config.hostname ? { hostname: config.hostname } : {}),
      ...(config.port === undefined ? {} : { port: config.port }),
      ...(config.username ? { username: config.username } : {}),
    };
  }

  private getAuthenticationMode(config: BackendConnectionConfig): AcpAuthenticationMode | undefined {
    if (config.transport !== "ssh") {
      return undefined;
    }

    const identityFile = config.identityFile?.trim();
    const password = config.password?.trim();
    if (identityFile) {
      return "identity";
    }
    if (password) {
      return "password";
    }
    return "agent";
  }

  private isAuthenticationFailure(
    command: string,
    exitCode: number,
    config: BackendConnectionConfig,
  ): boolean {
    return config.transport === "ssh"
      && isSshAuthenticationFailureExit(command, exitCode);
  }

  private getConnectionDetails(
    config: BackendConnectionConfig,
    attempt: number,
  ): Readonly<Record<string, unknown>> {
    return {
      transport: config.transport ?? "stdio",
      ...(this.getAuthenticationMode(config)
        ? { authenticationMode: this.getAuthenticationMode(config) }
        : {}),
      stage: this.stage,
      attempt,
      target: this.getTargetDetails(config),
      initializationCompleted: this.stage === "runtime",
    };
  }

  private getAbortError(
    signal: AbortSignal | undefined,
    config: BackendConnectionConfig,
  ): AcpError {
    const reason = signal?.reason;
    if (reason instanceof AcpError) {
      return reason;
    }
    if (reason instanceof Error && reason.name !== "AbortError") {
      return createAcpConnectionAbortedError({
        transport: config.transport,
        stage: this.stage,
        target: this.getTargetDetails(config),
        cause: reason,
      });
    }
    return createAcpConnectionAbortedError({
      transport: config.transport,
      stage: this.stage,
      target: this.getTargetDetails(config),
    });
  }

  private createConnectionAbortContext(
    config: BackendConnectionConfig,
    externalSignal: AbortSignal | undefined,
  ): {
    signal: AbortSignal;
    dispose: () => void;
  } {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abortFromExternalSignal = (): void => {
      if (!controller.signal.aborted) {
        controller.abort(externalSignal?.reason ?? this.getAbortError(controller.signal, config));
      }
    };

    if (externalSignal?.aborted) {
      abortFromExternalSignal();
    } else {
      externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });
    }

    if (config.transport === "ssh") {
      timer = setTimeout(() => {
        if (!controller.signal.aborted) {
          controller.abort(createAcpConnectionTimeoutError(
            this.reliabilityPolicy.connectionTimeoutMs,
            {
              transport: config.transport,
              stage: this.stage,
              target: this.getTargetDetails(config),
            },
          ));
        }
      }, this.reliabilityPolicy.connectionTimeoutMs);
    }

    return {
      signal: controller.signal,
      dispose: () => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        externalSignal?.removeEventListener("abort", abortFromExternalSignal);
      },
    };
  }
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  getAbortError: () => AcpError,
): Promise<T> {
  if (!signal) {
    return await operation;
  }
  if (signal.aborted) {
    throw getAbortError();
  }

  let abortHandler: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    abortHandler = () => reject(getAbortError());
    signal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    return await Promise.race([operation, abortPromise]);
  } finally {
    if (abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}
