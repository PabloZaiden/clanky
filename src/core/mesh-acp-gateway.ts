/**
 * Bounded ACP-over-WebSocket relay for mesh execution sessions.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import {
  buildProviderSpawnEnvironment,
  getProviderAcpCommand,
} from "./agent-runtime-command";
import { meshExecutionGateway } from "./mesh-execution-gateway";
import { DomainError } from "./domain-error";

const log = createLogger("core:mesh-acp-gateway");
const MAX_RELAY_SESSIONS = 64;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

export interface MeshAcpSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface RelayState {
  socket: MeshAcpSocket;
  process: Bun.Subprocess;
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

  async open(
    socket: MeshAcpSocket,
    sessionId: string,
    sessionToken: string,
  ): Promise<void> {
    if (this.relays.size >= MAX_RELAY_SESSIONS) {
      throw new DomainError("mesh_acp_unavailable", "The mesh ACP relay is at capacity.");
    }
    const config = await meshExecutionGateway.getAcpSessionConfig(sessionId, sessionToken);
    await this.close(sessionId);
    const providerCommand = getProviderAcpCommand(config.provider, "stdio");
    const child: Bun.Subprocess = Bun.spawn([providerCommand.command, ...providerCommand.args], {
      cwd: config.directory,
      env: buildProviderSpawnEnvironment(providerCommand, globalThis.process.env),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (
      !child.stdin
      || typeof child.stdin === "number"
      || !child.stdout
      || typeof child.stdout === "number"
    ) {
      await this.terminate(child);
      throw new DomainError("mesh_acp_process_failed", "The mesh ACP process did not expose usable streams.");
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
    this.relays.set(sessionId, { socket, process: child, expiryTimer });
    void this.forwardOutput(sessionId, child.stdout);
    if (child.stderr && typeof child.stderr !== "number") {
      void this.drainErrorOutput(sessionId, child.stderr);
    }
    void child.exited.then(() => {
      const relay = this.relays.get(sessionId);
      if (relay?.process !== child) return;
      this.relays.delete(sessionId);
      clearTimeout(relay.expiryTimer);
      try {
        socket.close(1011, "ACP process exited");
      } catch (error) {
        log.debug("Failed to close mesh ACP socket after process exit", { error: String(error) });
      }
    });
  }

  async message(sessionId: string, value: string | Buffer): Promise<void> {
    const relay = this.relays.get(sessionId);
    if (!relay || !relay.process.stdin || typeof relay.process.stdin === "number") {
      throw new DomainError("mesh_acp_unavailable", "The mesh ACP relay is not connected.");
    }
    const text = typeof value === "string" ? value : value.toString("utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
      throw new DomainError("mesh_acp_message_too_large", "The mesh ACP message exceeds the size limit.");
    }
    const message = assertJsonRpcMessage(JSON.parse(text) as unknown);
    relay.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close(sessionId: string): Promise<void> {
    const relay = this.relays.get(sessionId);
    if (!relay) {
      meshExecutionGateway.closeSession(sessionId);
      return;
    }
    this.relays.delete(sessionId);
    clearTimeout(relay.expiryTimer);
    await this.terminate(relay.process);
    meshExecutionGateway.closeSession(sessionId);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.relays.keys()].map((sessionId) => this.close(sessionId)));
    meshExecutionGateway.closeAll();
  }

  private async forwardOutput(sessionId: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    const relay = this.relays.get(sessionId);
    if (!relay) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (Buffer.byteLength(buffer, "utf8") > MAX_MESSAGE_BYTES) {
          await this.close(sessionId);
          return;
        }
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) this.sendLine(sessionId, line);
          newline = buffer.indexOf("\n");
        }

      }
      const rest = buffer.trim();
      if (rest) this.sendLine(sessionId, rest);
    } catch (error) {
      log.warn("Mesh ACP output relay failed", { sessionId, error: String(error) });
    } finally {
      reader.releaseLock();
    }
  }

  private async drainErrorOutput(sessionId: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch (error) {
      log.debug("Mesh ACP stderr relay ended", { sessionId, error: String(error) });
    } finally {
      reader.releaseLock();
    }
  }

  private sendLine(sessionId: string, line: string): void {
    if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) {
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

  private async terminate(process: Bun.Subprocess): Promise<void> {
    if (process.exitCode !== null) return;
    try {
      process.kill("SIGTERM");
    } catch {
      return;
    }
    await Promise.race([
      process.exited,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        timer.unref?.();
      }),
    ]);
    if (process.exitCode === null) {
      try {
        process.kill("SIGKILL");
      } catch {
        // The process may have exited between the checks.
      }
    }
  }
}

export const meshAcpGateway = new MeshAcpGateway();
