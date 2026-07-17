/**
 * Process and transport lifecycle service for the ACP backend.
 *
 * Sole owner of the ACP subprocess, stdout/stderr readers, recent diagnostic
 * output buffering, process-exit observation, and graceful/forced shutdown. It
 * exposes a narrow {@link RpcTransport} to the RPC client for writing wire
 * messages and forwards parsed inbound messages back to the RPC client. It does
 * not own JSON-RPC request bookkeeping or any session behavior.
 */

import { isRemoteOnlyMode } from "../../core/config";
import { log } from "../../core/logger";
import {
  buildProviderSpawnEnvironment,
  getProviderAcpCommand,
} from "../../core/agent-runtime-command";
import type { AgentProvider } from "@/shared/settings";
import type { BackendConnectionConfig, ConnectionInfo } from "../types";

import { sanitizeSpawnArgsForLogging, getProcessExitHint } from "./process-utils";
import { AcpError, createAcpProcessError, getAcpErrorMessage } from "./errors";
import { MAX_RECENT_PROCESS_LINES } from "./types";
import type { JsonRpcMessage } from "./types";
import type { RpcTransport } from "./contracts";
import type { RpcClient } from "./rpc-client";

const ACP_PROCESS_EXIT_WAIT_MS = 1_000;
const ACP_PROCESS_FORCE_KILL_WAIT_MS = 250;
const ACP_SSH_INITIALIZE_ATTEMPTS = 3;
const ACP_SSH_INITIALIZE_RETRY_DELAY_MS = 250;

export class AcpTransportLifecycle {
  private process: Bun.Subprocess | null = null;
  private connected = false;
  private directory = "";
  private provider: AgentProvider | null = null;
  private connectionInfo: ConnectionInfo | null = null;

  /** Recent non-JSON ACP process output lines for diagnostics. */
  private recentProcessLines: string[] = [];

  private rpc!: RpcClient;
  private onTransportClosed: ((error: AcpError) => void) | null = null;

  /** Narrow transport exposed to the RPC client for writing wire messages. */
  readonly transport: RpcTransport = {
    write: (message: JsonRpcMessage): void => this.writeRpcMessage(message),
    isWritable: (): boolean => {
      const process = this.process;
      return !!process && !!process.stdin && typeof process.stdin !== "number";
    },
  };

  /** Wire the RPC client after both collaborators are constructed. */
  setRpcClient(rpc: RpcClient): void {
    this.rpc = rpc;
  }

  setTransportClosedHandler(handler: (error: AcpError) => void): void {
    this.onTransportClosed = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }

  hasProcess(): boolean {
    return this.process !== null;
  }

  getProcess(): Bun.Subprocess | null {
    return this.process;
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

  ensureConnected(): void {
    if (!this.connected || !this.process) {
      throw new Error("Not connected. Call connect() first.");
    }
  }

  /**
   * Connect to an ACP-capable agent by spawning the configured CLI over an ACP
   * stdio transport. On failure the provided teardown callback runs so the
   * facade can clear all collaborator state before the error propagates.
   */
  async connect(
    config: BackendConnectionConfig,
    signal: AbortSignal | undefined,
    teardown: () => Promise<void>,
  ): Promise<void> {
    if (this.connected) {
      throw new Error("Already connected. Call disconnect() first.");
    }

    this.directory = config.directory;
    this.provider = config.provider ?? "opencode";
    log.debug("[AcpBackend] connect requested", {
      transport: config.transport,
      provider: config.provider,
      directory: config.directory,
    });

    try {
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
      await this.connectSpawn(config, signal, teardown);
    } catch (error) {
      const process = this.detachForShutdown();
      await this.terminateProcess(process);
      throw error;
    }
  }

  private async connectSpawn(
    config: BackendConnectionConfig,
    signal: AbortSignal | undefined,
    teardown: () => Promise<void>,
  ): Promise<void> {
    const providerCommand = getProviderAcpCommand(config.provider ?? "opencode", config.transport);
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

    const maxAttempts = config.transport === "ssh" ? ACP_SSH_INITIALIZE_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.throwIfAborted(signal);
      this.recentProcessLines = [];
      let process: Bun.Subprocess;
      try {
        process = Bun.spawn([command, ...args], {
          cwd: spawnCwd,
          env: spawnEnv,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (error) {
        throw new Error(`Failed to spawn ACP process (${command}) in cwd '${spawnCwd}': ${String(error)}`);
      }

      this.process = process;
      if (config.startupStdin) {
        if (!process.stdin || typeof process.stdin === "number") {
          throw new Error("ACP process stdin is not writable for runtime bootstrap");
        }
        process.stdin.write(config.startupStdin);
      }
      this.startProcessReaders(command);

      try {
        await this.rpc.sendRequest("initialize", {
          protocolVersion: 1,
          clientInfo: {
            name: "clanky",
            version: "0.0.0",
          },
        });
        this.throwIfAbortedAfterInitialize(signal);
        break;
      } catch (error) {
        await this.terminateProcess(process);
        if (this.process === process) {
          this.process = null;
        }
        this.rpc.clearPending();

        const failure = error instanceof AcpError
          ? error
          : new AcpError(
              "acp_process_failed",
              `Failed to initialize ACP process (${command}): ${getAcpErrorMessage(error)}`,
              { cause: error },
            );
        if (failure.code !== "acp_ssh_authentication_failed" || attempt >= maxAttempts) {
          await teardown();
          throw failure;
        }

        log.warn("[AcpBackend] Retrying ACP SSH initialization after transient auth failure", {
          attempt,
          maxAttempts,
          provider: config.provider,
          hostname: config.hostname,
          port: config.port,
        });
        await Bun.sleep(ACP_SSH_INITIALIZE_RETRY_DELAY_MS);
      }
    }
    log.debug("[AcpBackend] ACP runtime initialized", { command });

    this.connectionInfo = {
      baseUrl: `acp://stdio/${command}`,
      authHeaders: {},
    };
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new AcpError("acp_process_failed", "ACP connection aborted before initialization");
    }
  }

  private throwIfAbortedAfterInitialize(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) {
      return;
    }
    throw new AcpError("acp_process_failed", "ACP connection aborted during initialization");
  }

  /** Reset connection metadata and diagnostics; returns the detached process. */
  detachForShutdown(): Bun.Subprocess | null {
    const process = this.process;
    this.process = null;
    this.connected = false;
    this.directory = "";
    this.provider = null;
    this.connectionInfo = null;
    this.recentProcessLines = [];
    return process;
  }

  private startProcessReaders(command: string): void {
    const process = this.process;
    if (
      !process
      || !process.stdout
      || !process.stderr
      || typeof process.stdout === "number"
      || typeof process.stderr === "number"
    ) {
      return;
    }

    void this.readRpcStream(process, process.stdout, "stdout");
    void this.readRpcStream(process, process.stderr, "stderr");
    void process.exited.then((exitCode) => {
      if (this.process !== process || !this.connected) {
        return;
      }
      const hint = getProcessExitHint(command, exitCode);
      const details = this.recentProcessLines.slice(-5).join(" | ");
      const parts = [`ACP process exited with code ${exitCode}`];
      if (details.length > 0) {
        parts.push(details);
      }
      if (hint) {
        parts.push(hint);
      }
      const reason = parts.join(": ");
      const error = createAcpProcessError(reason, {
        command,
        exitCode,
      });
      this.connected = false;
      this.process = null;
      this.connectionInfo = null;
      this.rpc.rejectPending(error);
      this.onTransportClosed?.(error);
    });
  }

  private pushProcessLine(line: string): void {
    this.recentProcessLines.push(line);
    if (this.recentProcessLines.length > MAX_RECENT_PROCESS_LINES) {
      this.recentProcessLines.shift();
    }
  }

  async terminateProcess(process: Bun.Subprocess | null): Promise<void> {
    if (!process || process.exitCode !== null) {
      return;
    }

    try {
      process.kill("SIGTERM");
    } catch (error) {
      log.debug("[AcpBackend] Failed to send SIGTERM while disconnecting ACP runtime", {
        error: String(error),
      });
    }

    const exitedAfterTerminate = await this.waitForProcessExit(process, ACP_PROCESS_FORCE_KILL_WAIT_MS);
    if (exitedAfterTerminate) {
      return;
    }

    try {
      process.kill("SIGKILL");
    } catch (error) {
      log.debug("[AcpBackend] Failed to send SIGKILL while disconnecting ACP runtime", {
        error: String(error),
      });
    }

    await this.waitForProcessExit(process, ACP_PROCESS_EXIT_WAIT_MS);
  }

  private async waitForProcessExit(process: Bun.Subprocess, timeoutMs: number): Promise<boolean> {
    if (process.exitCode !== null) {
      return true;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exited = await Promise.race<boolean>([
        process.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
      return exited || process.exitCode !== null;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private async readRpcStream(
    process: Bun.Subprocess,
    stream: ReadableStream<Uint8Array>,
    source: "stdout" | "stderr",
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line.length > 0) {
            this.handleRpcLine(process, line, source);
          }
          newlineIndex = buffer.indexOf("\n");
        }
      }

      const rest = buffer.trim();
      if (rest.length > 0) {
        this.handleRpcLine(process, rest, source);
      }
    } catch (error) {
      log.warn(`[AcpBackend] ACP ${source} stream ended with error`, {
        error: String(error),
      });
    } finally {
      reader.releaseLock();
    }
  }

  private handleRpcLine(process: Bun.Subprocess, line: string, source: "stdout" | "stderr"): void {
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

    this.rpc.handleMessage(message);
  }

  private writeRpcMessage(message: JsonRpcMessage): void {
    const process = this.process;
    if (!process || !process.stdin) {
      throw new Error("ACP process is not available");
    }
    if (typeof process.stdin === "number") {
      throw new Error("ACP process stdin is not writable");
    }

    log.trace("[AcpBackend] Writing RPC message", {
      id: message.id,
      method: message.method,
      params: message.params,
    });

    process.stdin.write(`${JSON.stringify(message)}\n`);
  }
}
