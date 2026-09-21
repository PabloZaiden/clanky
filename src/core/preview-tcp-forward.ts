import net from "node:net";
import type { ExecutionHostBinding } from "@/shared";
import { createLogger } from "@pablozaiden/webapp/server";
import { DomainError } from "../domain/domain-error";
import { openTcpTunnel, type TcpTunnel } from "./tcp-tunnel";

const log = createLogger("core:preview-tcp-forward");
const PREVIEW_FORWARD_HOST = "127.0.0.1";

export interface PreviewTcpForward {
  readonly localPort: number;
  close(): Promise<void>;
}

export interface PreviewTcpForwardDependencies {
  openTunnel?: typeof openTcpTunnel;
}

interface ForwardConnection {
  socket: net.Socket;
  tunnel?: TcpTunnel;
  closed: boolean;
}

class PreviewTcpForwarder implements PreviewTcpForward {
  private readonly server: net.Server;
  private readonly connections = new Set<ForwardConnection>();
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private startupReject: ((error: Error) => void) | undefined;
  private started = false;
  private _localPort: number | undefined;

  constructor(
    private readonly binding: ExecutionHostBinding,
    private readonly remotePort: number,
    private readonly openTunnel: typeof openTcpTunnel,
  ) {
    this.server = net.createServer((socket) => {
      void this.handleConnection(socket);
    });
    this.server.on("error", (error) => {
      if (this.startupReject) {
        const reject = this.startupReject;
        this.startupReject = undefined;
        reject(error);
        return;
      }
      log.error("Preview TCP forward failed", {
        localPort: this._localPort,
        remotePort: this.remotePort,
        error: String(error),
      });
      void this.close();
    });
  }

  get localPort(): number {
    if (this._localPort === undefined) {
      throw new Error("Preview TCP forward is not listening");
    }
    return this._localPort;
  }

  async start(): Promise<void> {
    if (this.closing) {
      throw new DomainError(
        "preview_tcp_forward_closed",
        "The preview TCP forward is already closed.",
      );
    }

    await new Promise<void>((resolve, reject) => {
      this.startupReject = reject;
      this.server.once("listening", () => {
        const address = this.server.address();
        if (!address || typeof address === "string") {
          this.startupReject = undefined;
          reject(new Error("Preview TCP forward did not expose a local port"));
          return;
        }
        this.startupReject = undefined;
        this._localPort = address.port;
        this.started = true;
        resolve();
      });
      this.server.listen({
        host: PREVIEW_FORWARD_HOST,
        port: 0,
      });
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return await this.closePromise;
    }

    this.closing = true;
    this.closePromise = (async () => {
      for (const connection of [...this.connections]) {
        this.closeConnection(connection);
      }
      if (!this.started || !this.server.listening) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.server.close(() => resolve());
      });
    })();
    return await this.closePromise;
  }

  private async handleConnection(socket: net.Socket): Promise<void> {
    const connection: ForwardConnection = {
      socket,
      closed: false,
    };
    this.connections.add(connection);
    socket.pause();

    const closeConnection = () => this.closeConnection(connection);
    socket.once("close", closeConnection);
    socket.once("error", closeConnection);

    try {
      if (this.closing) {
        closeConnection();
        return;
      }
      const tunnel = await this.openTunnel({
        binding: this.binding,
        remoteHost: "127.0.0.1",
        remotePort: this.remotePort,
      });
      connection.tunnel = tunnel;
      tunnel.on("data", (data) => {
        if (!connection.closed && !socket.destroyed) {
          socket.write(data);
        }
      });
      tunnel.once("close", closeConnection);
      tunnel.once("error", closeConnection);
      if (connection.closed || this.closing || tunnel.destroyed) {
        closeConnection();
        return;
      }

      socket.on("data", (data) => {
        if (connection.closed) {
          return;
        }
        try {
          tunnel.write(data);
        } catch (error) {
          log.warn("Preview TCP forward connection failed", {
            localPort: this._localPort,
            remotePort: this.remotePort,
            error: String(error),
          });
          closeConnection();
        }
      });
      socket.resume();
    } catch (error) {
      log.warn("Unable to connect preview TCP forward", {
        localPort: this._localPort,
        remotePort: this.remotePort,
        error: String(error),
      });
      closeConnection();
    }
  }

  private closeConnection(connection: ForwardConnection): void {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    this.connections.delete(connection);
    connection.tunnel?.destroy();
    if (!connection.socket.destroyed) {
      connection.socket.destroy();
    }
  }
}

export async function openPreviewTcpForward(
  binding: ExecutionHostBinding,
  remotePort: number,
  dependencies: PreviewTcpForwardDependencies = {},
): Promise<PreviewTcpForward> {
  if (binding.host.kind !== "mesh") {
    throw new DomainError(
      "preview_tcp_forward_target_invalid",
      "A Mesh execution host is required for a preview TCP forward.",
    );
  }
  const forward = new PreviewTcpForwarder(
    binding,
    remotePort,
    dependencies.openTunnel ?? openTcpTunnel,
  );
  try {
    await forward.start();
    return forward;
  } catch (error) {
    await forward.close();
    throw error;
  }
}
