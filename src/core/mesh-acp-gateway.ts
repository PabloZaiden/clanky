/**
 * Bounded ACP-over-WebSocket relay for mesh execution sessions.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import { MESH_EXECUTION_MAX_MESSAGE_BYTES } from "@/shared/mesh-execution";
import { AcpProcess } from "../backends/acp/acp-process";
import {
  buildProviderSpawnEnvironment,
  getProviderAcpCommand,
} from "./agent-runtime-command";
import { meshExecutionGateway } from "./mesh-execution-gateway";
import { DomainError } from "./domain-error";

const log = createLogger("core:mesh-acp-gateway");
const MAX_RELAY_SESSIONS = 64;

export interface MeshAcpSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface RelayState {
  socket: MeshAcpSocket;
  process: AcpProcess;
  expiryTimer: ReturnType<typeof setTimeout>;
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
  private readonly opening = new Map<string, Promise<void>>();
  private readonly closing = new Set<string>();

  async open(
    socket: MeshAcpSocket,
    sessionId: string,
    sessionToken: string,
  ): Promise<void> {
    const opening = this.openRelay(socket, sessionId, sessionToken);
    this.opening.set(sessionId, opening);
    try {
      await opening;
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
  ): Promise<void> {
    if (this.relays.size >= MAX_RELAY_SESSIONS) {
      throw new DomainError("mesh_acp_unavailable", "The mesh ACP relay is at capacity.");
    }
    const config = await meshExecutionGateway.getAcpSessionConfig(sessionId, sessionToken);
    await this.closeRelay(sessionId);
    const providerCommand = getProviderAcpCommand(config.provider, "stdio");
    let processHandle: AcpProcess | null = null;
    let processExited = false;
    let outputLimitExceeded = false;
    try {
      const spawned = await AcpProcess.spawn({
        command: providerCommand.command,
        args: providerCommand.args,
        cwd: config.directory,
        env: buildProviderSpawnEnvironment(providerCommand, globalThis.process.env),
        maxBufferedBytes: MESH_EXECUTION_MAX_MESSAGE_BYTES,
        maxLineBytes: MESH_EXECUTION_MAX_MESSAGE_BYTES,
        onLine: (source, line) => {
          if (source === "stdout") {
            this.sendLine(sessionId, line);
          }
        },
        onExit: () => {
          processExited = true;
          if (processHandle) {
            void this.handleProcessExit(sessionId, processHandle);
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
      processHandle = spawned;
    } catch (error) {
      throw new DomainError(
        "mesh_acp_process_failed",
        "The mesh ACP process did not expose usable streams.",
        { cause: error },
      );
    }
    const process = processHandle;
    if (!process) {
      throw new DomainError("mesh_acp_process_failed", "The mesh ACP process was not created.");
    }
    if (this.closing.has(sessionId)) {
      await process.stop({
        gracefulWaitMs: 500,
        forceWaitMs: 0,
      });
      meshExecutionGateway.closeSession(sessionId);
      return;
    }

    const expiryTimer = setTimeout(() => {
      void this.close(sessionId);
      try {
        socket.close(1000, "Mesh ACP session expired");
      } catch {
        // The socket may already be closed.
      }
    }, Math.max(1, config.expiresAt - Date.now()));
    expiryTimer.unref?.();
    this.relays.set(sessionId, { socket, process, expiryTimer });
    process.start();

    if (outputLimitExceeded) {
      await this.closeRelay(sessionId);
      return;
    }
    if (processExited || process.exitCode !== null) {
      await this.handleProcessExit(sessionId, process);
    }
  }

  async message(sessionId: string, value: string | Buffer): Promise<void> {
    const opening = this.opening.get(sessionId);
    if (opening) {
      await opening;
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
      try {
        await opening;
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

  private async closeRelay(sessionId: string): Promise<void> {
    const relay = this.relays.get(sessionId);
    if (!relay) {
      meshExecutionGateway.closeSession(sessionId);
      return;
    }
    this.relays.delete(sessionId);
    clearTimeout(relay.expiryTimer);
    await relay.process.stop({
      gracefulWaitMs: 500,
      forceWaitMs: 0,
    });
    meshExecutionGateway.closeSession(sessionId);
  }

  async closeAll(): Promise<void> {
    const sessionIds = new Set([...this.relays.keys(), ...this.opening.keys()]);
    await Promise.all([...sessionIds].map((sessionId) => this.close(sessionId)));
    meshExecutionGateway.closeAll();
  }

  private async handleProcessExit(sessionId: string, process: AcpProcess): Promise<void> {
    const relay = this.relays.get(sessionId);
    if (!relay || relay.process !== process) {
      return;
    }
    this.relays.delete(sessionId);
    clearTimeout(relay.expiryTimer);
    meshExecutionGateway.closeSession(sessionId);
    try {
      relay.socket.close(1011, "ACP process exited");
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

export const meshAcpGateway = new MeshAcpGateway();
