/**
 * ACP transport routing boundary for mesh-owned workspaces.
 *
 * The transport establishes the existing signed mesh execution session and
 * relays ACP JSON-RPC over the owner's bounded WebSocket gateway.
 */

import type { AgentProvider } from "@/shared/settings";
import {
  MESH_ACP_WEBSOCKET_OPEN_TIMEOUT_MS,
  MESH_EXECUTION_MAX_MESSAGE_BYTES,
} from "@/shared/mesh-execution";
import type { BackendConnectionConfig, ConnectionInfo } from "../types";
import { AcpError } from "./errors";
import {
  MeshCommandExecutorClient,
} from "../../core/mesh-command-executor-client";
import { resolveMeshRoute } from "../../core/mesh-transport-config";
import type {
  AcpTransportClosedEvent,
  AcpTransportLifecycle,
  AcpTransportSession,
  RpcPendingController,
  RpcRequester,
  RpcTransport,
} from "./contracts";
import type { JsonRpcMessage } from "./types";
import { LocalAcpTransportLifecycle } from "./transport-lifecycle";

export class MeshAcpTransport implements AcpTransportLifecycle {
  private connected = false;
  private directory = "";
  private provider: AgentProvider | null = null;
  private session: AcpTransportSession | null = null;
  private socket: WebSocket | null = null;
  private requester: (RpcRequester & RpcPendingController) | null = null;
  private closing = false;
  private connectionInfo: ConnectionInfo | null = null;
  private messageHandler: ((message: JsonRpcMessage) => void) | null = null;
  private transportClosedHandler: ((event: AcpTransportClosedEvent) => void) | null = null;
  private sessionClient: MeshCommandExecutorClient | null = null;

  readonly transport: RpcTransport = {
    write: (message: JsonRpcMessage): void => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        throw new AcpError("acp_transport_unavailable", "The Mesh ACP transport is not writable.");
      }
      this.socket.send(JSON.stringify(message));
    },
    isWritable: (): boolean => this.socket?.readyState === WebSocket.OPEN,
    waitForWritable: async (signal?: AbortSignal): Promise<void> => {
      if (this.socket?.readyState === WebSocket.OPEN) return;
      if (signal?.aborted) {
        throw new AcpError("acp_request_cancelled", "The Mesh ACP connection was aborted.");
      }
      throw new AcpError("acp_transport_unavailable", "The Mesh ACP transport is not writable.");
    },
  };

  setMessageHandler(handler: (message: JsonRpcMessage) => void): void {
    this.messageHandler = handler;
  }

  setTransportClosedHandler(handler: (event: AcpTransportClosedEvent) => void): void {
    this.transportClosedHandler = handler;
  }

  isConnected(): boolean {
    return this.connected;
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

  async connect(
    config: BackendConnectionConfig,
    signal: AbortSignal | undefined,
    requester: RpcRequester & RpcPendingController,
  ): Promise<unknown> {
    if (!config.mesh) {
      throw new AcpError(
        "acp_transport_unavailable",
        "Mesh ACP transport requires workspace ownership metadata.",
      );
    }
    this.directory = config.directory;
    this.provider = config.provider ?? "opencode";
    this.requester = requester;
    this.closing = false;
    const sessionClient = new MeshCommandExecutorClient({
      workspaceId: config.mesh.workspaceId,
      directory: config.directory,
      executionNodeId: config.mesh.executionNodeId,
      provider: this.provider,
      channel: "acp",
    });
    this.sessionClient = sessionClient;
    await sessionClient.openSession();
    const session = sessionClient.getSessionConnection();
    const websocketUrl = toWebSocketUrl(
      resolveMeshRoute(session.endpoint, "api/mesh/internal/execution/acp"),
    );
    const socket = createWebSocket(websocketUrl, {
      "x-clanky-mesh-session-id": session.sessionId,
      "x-clanky-mesh-session-token": session.sessionToken,
    });
    this.socket = socket;
    this.session = { id: crypto.randomUUID(), kind: "remote" };
    this.connectionInfo = { baseUrl: websocketUrl, authHeaders: {} };
    socket.onmessage = (event: MessageEvent) => {
      void this.handleSocketMessage(event.data);
    };
    socket.onerror = () => {
      this.failConnection("Mesh ACP WebSocket failed.");
    };
    socket.onclose = () => {
      if (this.closing) return;
      this.connected = false;
      const error = new AcpError("acp_transport_closed", "The Mesh ACP WebSocket closed.");
      this.requester?.rejectPending(error);
      const sessionState = this.session;
      if (sessionState) {
        this.transportClosedHandler?.({
          session: sessionState,
          reason: "remote-close",
          error,
        });
      }
      this.session = null;
    };
    try {
      await waitForWebSocketOpen(socket, signal);
    } catch (error) {
      sessionClient.closeSession();
      this.sessionClient = null;
      throw error;
    }
    this.connected = true;
    return await requester.sendRequest("initialize", {
      protocolVersion: 1,
      clientInfo: {
        name: "clanky",
        version: "0.0.0",
      },
    });
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    this.connected = false;
    this.requester = null;
    const socket = this.socket;
    this.socket = null;
    this.sessionClient?.closeSession();
    this.sessionClient = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close(1000, "Disconnected");
    }
    this.connected = false;
    this.directory = "";
    this.provider = null;
    this.session = null;
    this.connectionInfo = null;
    this.messageHandler = null;
    this.transportClosedHandler = null;
  }

  private async handleSocketMessage(data: unknown): Promise<void> {
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      text = new TextDecoder().decode(data);
    } else if (data instanceof Blob) {
      text = await data.text();
    } else {
      this.failConnection("Mesh ACP returned a non-text WebSocket message.");
      return;
    }
    if (Buffer.byteLength(text, "utf8") > MESH_EXECUTION_MAX_MESSAGE_BYTES) {
      this.failConnection("Mesh ACP message exceeds the size limit.");
      return;
    }
    try {
      const message = JSON.parse(text) as JsonRpcMessage;
      if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
        throw new Error("invalid JSON-RPC message");
      }
      this.messageHandler?.(message);
    } catch (error) {
      this.failConnection(`Mesh ACP returned invalid JSON-RPC: ${String(error)}`);
    }
  }

  private failConnection(message: string): void {
    const error = new AcpError("acp_transport_closed", message);
    this.requester?.rejectPending(error);
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      this.socket.close(1011, message);
    }
  }
}

function createWebSocket(url: string, headers: Record<string, string>): WebSocket {
  const BunWebSocket = WebSocket as unknown as {
    new (url: string | URL, options?: { headers?: Record<string, string> }): WebSocket;
  };
  return new BunWebSocket(url, { headers });
}

function toWebSocketUrl(url: string): string {
  return url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

async function waitForWebSocketOpen(socket: WebSocket, signal?: AbortSignal): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const abort = () => {
      cleanup();
      socket.close();
      reject(new AcpError("acp_request_cancelled", "The Mesh ACP connection was aborted."));
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new AcpError("acp_transport_unavailable", "The Mesh ACP WebSocket could not be opened."));
    };
    const onClose = () => {
      cleanup();
      reject(new AcpError("acp_transport_unavailable", "The Mesh ACP WebSocket closed before opening."));
    };
    timer = setTimeout(() => {
      cleanup();
      socket.close();
      reject(new AcpError("acp_transport_unavailable", "The Mesh ACP WebSocket open timed out."));
    }, MESH_ACP_WEBSOCKET_OPEN_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

export class WorkspaceAcpTransportLifecycle implements AcpTransportLifecycle {
  private delegate: AcpTransportLifecycle | null = null;
  private readonly workspaceId: string;
  private readonly localNodeId: string;
  private readonly executionNodeId: string | null;

  readonly transport: RpcTransport = {
    write: (message: JsonRpcMessage): void => {
      this.requireDelegate().transport.write(message);
    },
    isWritable: (): boolean => this.delegate?.transport.isWritable() ?? false,
    waitForWritable: async (signal?: AbortSignal): Promise<void> => {
      await this.requireDelegate().transport.waitForWritable?.(signal);
    },
  };

  constructor(options: {
    workspaceId: string;
    localNodeId: string;
    executionNodeId: string | null;
  }) {
    this.workspaceId = options.workspaceId;
    this.localNodeId = options.localNodeId;
    this.executionNodeId = options.executionNodeId;
  }

  setMessageHandler(handler: (message: JsonRpcMessage) => void): void {
    this.messageHandler = handler;
    this.delegate?.setMessageHandler(handler);
  }

  setTransportClosedHandler(handler: (event: AcpTransportClosedEvent) => void): void {
    this.transportClosedHandler = handler;
    this.delegate?.setTransportClosedHandler(handler);
  }

  isConnected(): boolean {
    return this.delegate?.isConnected() ?? false;
  }

  getDirectory(): string {
    return this.delegate?.getDirectory() ?? "";
  }

  getProvider(): AgentProvider | null {
    return this.delegate?.getProvider() ?? null;
  }

  getConnectionInfo(): ConnectionInfo | null {
    return this.delegate?.getConnectionInfo() ?? null;
  }

  getSession(): AcpTransportSession | null {
    return this.delegate?.getSession() ?? null;
  }

  async connect(
    config: BackendConnectionConfig,
    signal: AbortSignal | undefined,
    requester: RpcRequester & RpcPendingController,
  ): Promise<unknown> {
    const isRemoteOwner = this.executionNodeId !== null
      && this.executionNodeId !== this.localNodeId;
    this.delegate = isRemoteOwner
      ? new MeshAcpTransport()
      : new LocalAcpTransportLifecycle();
    this.delegate.setMessageHandler(this.messageHandler ?? (() => undefined));
    this.delegate.setTransportClosedHandler(this.transportClosedHandler ?? (() => undefined));
    return await this.delegate.connect(
      isRemoteOwner
        ? {
            ...config,
            mesh: {
              workspaceId: this.workspaceId,
              executionNodeId: this.executionNodeId as string,
            },
          }
        : config,
      signal,
      requester,
    );
  }

  async disconnect(): Promise<void> {
    await this.delegate?.disconnect();
    this.delegate = null;
  }

  private messageHandler: ((message: JsonRpcMessage) => void) | null = null;
  private transportClosedHandler: ((event: AcpTransportClosedEvent) => void) | null = null;

  private requireDelegate(): AcpTransportLifecycle {
    if (!this.delegate) {
      throw new AcpError("acp_transport_unavailable", "The ACP transport is not connected.");
    }
    return this.delegate;
  }
}
