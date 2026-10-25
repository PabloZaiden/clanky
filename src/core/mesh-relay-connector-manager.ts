/**
 * Server adapter for the shared relay lifecycle and authoritative inbound serving.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import type { MeshRelayPeerRoute } from "@/shared/mesh";
import type { MeshRelayAuthOkFrame, MeshRelayPeerIdentity } from "@/shared/mesh-relay";
import {
  MeshRelayConnectorManager as PortableRelayManager,
  type MeshRelayConnectionRequest as PortableConnectionRequest,
  type MeshRelayConnectorManagerOptions as PortableManagerOptions,
} from "../client-sdk/collaboration/relay-manager";
import {
  createMeshNodeRelayConnector, loadMeshNodeRelayIdentity,
} from "./mesh-relay-node-connector";
import { createMeshRelayInboundHandler, type MeshRelayInboundOptions } from "./mesh-relay-inbound";
import { setMeshRelayTransport } from "./mesh-peer-transport";
import { createMeshRelayPeerTransport } from "./mesh-relay-transport";
export { MESH_RELAY_RECONNECT_BASE_DELAY_MS, MESH_RELAY_RECONNECT_MAX_DELAY_MS } from "../client-sdk/collaboration/relay-manager";

const log = createLogger("core:mesh-relay-connector-manager");

export interface MeshRelayConnectionRequest extends Omit<PortableConnectionRequest, "inbound" | "onStopped"> {
  dispatch(request: Request): Promise<Response | undefined>;
  openWorkspaceClientSocket?: MeshRelayInboundOptions["openWorkspaceClientSocket"];
}

export interface MeshRelayConnectorManagerOptions extends Omit<PortableManagerOptions, "identity"> {
  identity?: PortableManagerOptions["identity"];
  manageTransport?: boolean;
}

export class MeshRelayConnectorManager {
  private readonly lifecycle: PortableRelayManager;

  constructor(private readonly options: MeshRelayConnectorManagerOptions = {}) {
    this.lifecycle = new PortableRelayManager({
      ...options,
      identity: options.identity ?? loadMeshNodeRelayIdentity,
      logger: options.logger ?? log,
      createConnector: options.createConnector ?? createMeshNodeRelayConnector,
    });
  }

  get status() { return this.lifecycle.status; }
  get authorization() { return this.lifecycle.authorization; }
  get activeConfig() { return this.lifecycle.activeConfig; }

  start(request: MeshRelayConnectionRequest): void {
    this.lifecycle.start({
      config: request.config,
      onAuthenticated: request.onAuthenticated,
      onStatusChange: request.onStatusChange,
      shouldMaintain: request.shouldMaintain,
      refreshProtocol: request.refreshProtocol,
      inbound: createMeshRelayInboundHandler({
        role: request.config.role,
        dispatch: request.dispatch,
        openWorkspaceClientSocket: request.openWorkspaceClientSocket,
      }),
      onStopped: () => {
        if (this.options.manageTransport !== false) setMeshRelayTransport(null);
      },
    });
    if (this.options.manageTransport !== false) {
      setMeshRelayTransport(createMeshRelayPeerTransport((route) => this.resolveConnector(route)));
    }
  }

  async stop(): Promise<void> {
    if (this.options.manageTransport !== false) setMeshRelayTransport(null);
    await this.lifecycle.stop();
  }

  async waitUntilConnected(timeoutMs?: number): Promise<MeshRelayAuthOkFrame> {
    return await this.lifecycle.waitUntilConnected(timeoutMs);
  }

  async replaceAuthorization(workers: MeshRelayPeerIdentity[], clients?: MeshRelayPeerIdentity[]): Promise<number> {
    return await this.lifecycle.replaceAuthorization(workers, clients);
  }

  closeCurrentConnection(code?: number, reason?: string): void {
    this.lifecycle.closeCurrentConnection(code, reason);
  }

  resolveConnector(route: MeshRelayPeerRoute) {
    return this.lifecycle.resolveConnector(route);
  }
}
