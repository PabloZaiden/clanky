/**
 * Bounded ACP-over-WebSocket relay for mesh execution sessions.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import {
  MESH_ACP_CHANNEL,
  MESH_ACP_RELAY_CLOSE_TIMEOUT_MS,
  MESH_ACP_STARTUP_TIMEOUT_MS,
  MESH_EXECUTION_MAX_MESSAGE_BYTES,
} from "@/shared/mesh-execution";
import { AcpProcess } from "../backends/acp/acp-process";
import type { AcpProcessExit } from "../backends/acp/types";
import {
  buildProviderSpawnEnvironment,
  getProviderAcpCommand,
} from "./agent-runtime-command";
import { meshExecutionGateway } from "./mesh-execution-gateway";
import { DomainError } from "./domain-error";
import { CommandExecutorImpl } from "./remote-command-executor";

const log = createLogger("core:mesh-acp-gateway");
const MAX_RELAY_SESSIONS = 64;
const MAX_STARTUP_STDERR_BYTES = 2_048;

function appendStartupDiagnostic(current: string, line: string): string {
  const combined = `${current}${current ? "\n" : ""}${line}`.replace(/[\r\n\t]+/g, " ");
  if (Buffer.byteLength(combined, "utf8") <= MAX_STARTUP_STDERR_BYTES) {
    return combined;
  }
  let bounded = combined;
  while (Buffer.byteLength(bounded, "utf8") > MAX_STARTUP_STDERR_BYTES) {
    bounded = bounded.slice(1);
  }
  return bounded;
}

function meshAcpExitReason(
  provider: string,
  exit: AcpProcessExit,
  stderr: string,
): string {
  const status = exit.signalCode
    ? `signal ${exit.signalCode}`
    : `code ${String(exit.exitCode)}`;
  let reason = `${provider} ACP exited with ${status}`;
  const diagnostic = stderr.trim();
  if (diagnostic) {
    reason += `: ${diagnostic}`;
  }
  while (Buffer.byteLength(reason, "utf8") > 123) {
    reason = reason.slice(0, -1);
  }
  return reason;
}

export interface MeshAcpSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface RelayState {
  socket: MeshAcpSocket;
  process: AcpProcess;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

interface OpeningState {
  promise: Promise<void>;
  controller: AbortController;
}

function assertJsonRpcMessage(value: unknown): Record<string, unknown> {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || (value as Record<string, unknown>)["jsonrpc"] !== "2.0"
  ) {
    throw new DomainError("mesh_acp_message_invalid", "The mesh ACP message is not a JSON-RPC 2.0 object.");
  }
  return value as Record<string, unknown>;
}

export class MeshAcpGateway {
  private readonly relays = new Map<string, RelayState>();
  private readonly opening = new Map<string, OpeningState>();
  private readonly closing = new Set<string>();

  async open(
    socket: MeshAcpSocket,
    sessionId: string,
    sessionToken: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const controller = new AbortController();
    const abortHandler = (): void => {
      controller.abort(signal?.reason);
    };
    if (signal?.aborted) {
      abortHandler();
    } else {
      signal?.addEventListener("abort", abortHandler, { once: true });
    }
    const timeout = setTimeout(() => {
      controller.abort(new DomainError(
        "mesh_acp_startup_timed_out",
        `Mesh ACP relay startup timed out after ${MESH_ACP_STARTUP_TIMEOUT_MS}ms.`,
      ));
    }, MESH_ACP_STARTUP_TIMEOUT_MS);
    timeout.unref?.();
    const openingPromise = this.openRelay(socket, sessionId, sessionToken, controller.signal)
      .finally(() => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abortHandler);
      });
    const opening: OpeningState = { promise: openingPromise, controller };
    this.opening.set(sessionId, opening);
    try {
      await openingPromise;
    } finally {
      if (this.opening.get(sessionId) === opening) {
        this.opening.delete(sessionId);
      }
    }
  }

  private async openRelay(
    socket: MeshAcpSocket,
    sessionId: string,
    sessionToken: string,
    signal: AbortSignal,
  ): Promise<void> {
    let processHandle: AcpProcess | null = null;
    try {
      throwIfAborted(signal);
      if (this.relays.size >= MAX_RELAY_SESSIONS) {
        throw new DomainError("mesh_acp_unavailable", "The mesh ACP relay is at capacity.");
      }
      const config = await raceWithAbort(
        meshExecutionGateway.getAcpSessionConfig(sessionId, sessionToken),
        signal,
      );
      throwIfAborted(signal);
      await this.stopRelay(sessionId);
      const directoryCheck = await new CommandExecutorImpl({
        provider: "local",
        directory: ".",
      }).exec(
        "/bin/sh",
        ["-c", "test -d \"$1\"", "clanky-acp-directory-check", config.directory],
        {
          cwd: ".",
          maxOutputBytes: 16 * 1024,
          signal,
          timeout: MESH_ACP_STARTUP_TIMEOUT_MS,
        },
      );
      if (signal.aborted || directoryCheck.exitCode === 130) {
        throwIfAborted(signal);
        throw new DomainError("mesh_acp_open_aborted", "The Mesh ACP directory check was aborted.");
      }
      if (directoryCheck.exitCode === 124) {
        throw new DomainError(
          "mesh_acp_startup_timed_out",
          `The Mesh ACP directory check timed out after ${MESH_ACP_STARTUP_TIMEOUT_MS}ms.`,
        );
      }
      if (!directoryCheck.success) {
        throw new DomainError(
          "mesh_acp_directory_invalid",
          `The ACP working directory does not exist: ${config.directory}`,
        );
      }
      throwIfAborted(signal);
      const providerCommand = getProviderAcpCommand(config.provider, "stdio");
      let processExit: AcpProcessExit | null = null;
      let outputLimitExceeded = false;
      let startupStderr = "";
      const spawnPromise = AcpProcess.spawn({
          command: providerCommand.command,
          args: providerCommand.args,
          cwd: config.directory,
          env: buildProviderSpawnEnvironment(
            providerCommand,
            globalThis.process.env,
            config.environment,
          ),
          maxBufferedBytes: MESH_EXECUTION_MAX_MESSAGE_BYTES,
          maxLineBytes: MESH_EXECUTION_MAX_MESSAGE_BYTES,
          onLine: (source, line) => {
            if (source === "stdout") {
              this.sendLine(sessionId, line);
            } else {
              startupStderr = appendStartupDiagnostic(startupStderr, line);
            }
          },
          onExit: (exit) => {
            processExit = exit;
            if (processHandle) {
              void this.handleProcessExit(
                sessionId,
                processHandle,
                config.provider,
                exit,
                startupStderr,
              );
            }
          },
          onOutputLimitExceeded: () => {
            outputLimitExceeded = true;
            if (this.relays.has(sessionId)) {
              void this.close(sessionId);
            }
          },
          onStreamError: (source, error) => {
            log.warn("Mesh ACP process stream failed", {
              sessionId,
              source,
              error: String(error),
            });
          },
        });
      const spawned = await raceWithAbort(spawnPromise, signal).catch(async (error) => {
        await spawnPromise.then(
          (process) => process.stop({ gracefulWaitMs: 0, forceWaitMs: 0 }),
          () => undefined,
        );
        throw error;
      });
      processHandle = spawned;
      const process = processHandle;
      if (!process) {
        throw new DomainError("mesh_acp_process_failed", "The mesh ACP process was not created.");
      }
      if (this.closing.has(sessionId) || signal.aborted) {
        await process.stop({
          gracefulWaitMs: 500,
          forceWaitMs: 0,
        });
        return;
      }

      const relay: RelayState = { socket, process };
      this.relays.set(sessionId, relay);
      this.scheduleRelayExpiry(sessionId, relay, config.expiresAt);
      process.start();

      if (outputLimitExceeded) {
        await this.closeRelay(sessionId);
        return;
      }
      if (processExit || process.exitCode !== null) {
        await this.handleProcessExit(
          sessionId,
          process,
          config.provider,
          processExit ?? {
            exitCode: process.exitCode ?? -1,
            signalCode: process.signalCode,
          },
          startupStderr,
        );
      }
    } catch (error) {
      if (processHandle) {
        await processHandle.stop({
          gracefulWaitMs: 0,
          forceWaitMs: 0,
        });
      }
      throw error instanceof DomainError
        ? error
        : new DomainError(
          "mesh_acp_process_failed",
          `Failed to start the mesh ACP provider: ${String(error)}`,
          { cause: error },
        );
    } finally {
      if (!this.relays.has(sessionId)) {
        meshExecutionGateway.closeSession(sessionId);
      }
    }
  }

  private scheduleRelayExpiry(
    sessionId: string,
    relay: RelayState,
    expiresAt: number,
  ): void {
    if (relay.expiryTimer !== undefined) {
      clearTimeout(relay.expiryTimer);
    }
    const expiryTimer = setTimeout(() => {
      if (this.relays.get(sessionId) !== relay) {
        return;
      }
      void this.close(sessionId);
      try {
        relay.socket.close(1000, "Mesh ACP session expired");
      } catch {
        // The socket may already be closed.
      }
    }, Math.max(1, expiresAt - Date.now()));
    expiryTimer.unref?.();
    relay.expiryTimer = expiryTimer;
  }

  async renew(sessionId: string, sessionToken: string): Promise<number> {
    const relay = this.relays.get(sessionId);
    if (!relay) {
      throw new DomainError("mesh_acp_unavailable", "The mesh ACP relay is not connected.");
    }
    let expiresAt: number;
    try {
      expiresAt = await meshExecutionGateway.renewSession(
        sessionId,
        sessionToken,
        MESH_ACP_CHANNEL,
      );
    } catch (error) {
      if (
        this.relays.get(sessionId) === relay
        && error instanceof DomainError
        && (
          error.code === "mesh_execution_context_changed"
          || error.code === "mesh_execution_session_expired"
          || error.code === "mesh_execution_session_invalid"
          || error.code === "mesh_execution_capability_unavailable"
          || error.code === "mesh_remote_execution_disabled"
        )
      ) {
        await this.closeRelay(sessionId);
        try {
          relay.socket.close(1011, "Mesh ACP session unavailable");
        } catch (closeError) {
          log.debug("Failed to close mesh ACP socket after renewal failure", {
            sessionId,
            error: String(closeError),
          });
        }
      }
      throw error;
    }
    if (this.relays.get(sessionId) !== relay) {
      meshExecutionGateway.closeSession(sessionId);
      throw new DomainError("mesh_acp_unavailable", "The mesh ACP relay is not connected.");
    }
    this.scheduleRelayExpiry(sessionId, relay, expiresAt);
    return expiresAt;
  }

  async message(sessionId: string, value: string | Buffer): Promise<void> {
    const opening = this.opening.get(sessionId);
    if (opening) {
      await opening.promise;
    }
    const relay = this.relays.get(sessionId);
    if (!relay || !relay.process.isWritable()) {
      throw new DomainError("mesh_acp_unavailable", "The mesh ACP relay is not connected.");
    }
    const text = typeof value === "string" ? value : value.toString("utf8");
    if (Buffer.byteLength(text, "utf8") > MESH_EXECUTION_MAX_MESSAGE_BYTES) {
      throw new DomainError("mesh_acp_message_too_large", "The mesh ACP message exceeds the size limit.");
    }
    const message = assertJsonRpcMessage(JSON.parse(text) as unknown);
    relay.process.write(`${JSON.stringify(message)}\n`);
  }

  async close(sessionId: string): Promise<void> {
    const opening = this.opening.get(sessionId);
    if (opening) {
      this.closing.add(sessionId);
      opening.controller.abort(new DomainError(
        "mesh_acp_open_aborted",
        "The mesh ACP relay was closed while it was starting.",
      ));
      try {
        await waitForSettlement(opening.promise, MESH_ACP_RELAY_CLOSE_TIMEOUT_MS);
      } catch (error) {
        log.debug("Mesh ACP relay opening failed while closing", {
          sessionId,
          error: String(error),
        });
      } finally {
        this.closing.delete(sessionId);
      }

    }
    await this.closeRelay(sessionId);
  }

  private async stopRelay(sessionId: string): Promise<void> {
    const relay = this.relays.get(sessionId);
    if (!relay) {
      return;
    }
    this.relays.delete(sessionId);
    if (relay.expiryTimer !== undefined) {
      clearTimeout(relay.expiryTimer);
      relay.expiryTimer = undefined;
    }
    await relay.process.stop({
      gracefulWaitMs: 500,
      forceWaitMs: 0,
    });
  }

  private async closeRelay(sessionId: string): Promise<void> {
    await this.stopRelay(sessionId);
    meshExecutionGateway.closeSession(sessionId);
  }

  async closeAll(): Promise<void> {
    const sessionIds = new Set([...this.relays.keys(), ...this.opening.keys()]);
    await Promise.all([...sessionIds].map((sessionId) => this.close(sessionId)));
    meshExecutionGateway.closeAll();
  }

  private async handleProcessExit(
    sessionId: string,
    process: AcpProcess,
    provider: string,
    exit: AcpProcessExit,
    stderr: string,
  ): Promise<void> {
    const relay = this.relays.get(sessionId);
    if (!relay || relay.process !== process) {
      return;
    }
    this.relays.delete(sessionId);
    if (relay.expiryTimer !== undefined) {
      clearTimeout(relay.expiryTimer);
      relay.expiryTimer = undefined;
    }
    meshExecutionGateway.closeSession(sessionId);
    try {
      relay.socket.close(1011, meshAcpExitReason(provider, exit, stderr));
    } catch (error) {
      log.debug("Failed to close mesh ACP socket after process exit", {
        sessionId,
        error: String(error),
      });
    }
  }

  private sendLine(sessionId: string, line: string): void {
    if (Buffer.byteLength(line, "utf8") > MESH_EXECUTION_MAX_MESSAGE_BYTES) {
      void this.close(sessionId);
      return;
    }
    try {
      const relay = this.relays.get(sessionId);
      if (!relay) return;
      assertJsonRpcMessage(JSON.parse(line) as unknown);
      relay.socket.send(line);
    } catch (error) {
      log.warn("Mesh ACP output was not valid JSON-RPC", { sessionId, error: String(error) });
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof DomainError
      ? signal.reason
      : new DomainError("mesh_acp_open_aborted", "The mesh ACP relay was aborted.");
  }
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let abortHandler: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    abortHandler = () => reject(
      signal.reason instanceof Error
        ? signal.reason
        : new DomainError("mesh_acp_open_aborted", "The mesh ACP relay was aborted."),
    );
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

async function waitForSettlement(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new DomainError(
          "mesh_acp_close_timed_out",
          `Mesh ACP relay cleanup timed out after ${timeoutMs}ms.`,
        )), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export const meshAcpGateway = new MeshAcpGateway();
