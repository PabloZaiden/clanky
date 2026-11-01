import { sign } from "node:crypto";
import { createLogger } from "@pablozaiden/webapp/server";
import { isMeshOutboundRoute } from "@/shared/mesh";
import { MESH_PROTOCOL_VERSION } from "@/shared/mesh-protocol";
import { listActiveControllerWorkerIdentities } from "../persistence/controller-relay-pairing";
import { ensureLocalMeshNodeIdentity, getLocalMeshSigningKey } from "../persistence/mesh-node-identity";
import { DomainError } from "../domain/domain-error";
import { meshStateEventEmitter } from "./event-emitter";
import { createMeshLocalBrokerSocketFactory } from "./mesh-local-broker-socket";
import { MeshRelayBroker } from "./mesh-relay-broker";
import { MeshRelayConnectorManager } from "./mesh-relay-connector-manager";
import { MeshRelayStore } from "./mesh-relay-store";
import { createRelayWebSocketHandler } from "./mesh-relay-server";
import { setMeshOutboundTransport } from "./mesh-peer-transport";
import { createMeshStreamPeerTransport } from "./mesh-relay-transport";

const log = createLogger("core:controller-worker-connections");
const LOCAL_BROKER_ORIGIN = "https://controller.mesh.invalid";

class ControllerWorkerConnectionService {
  private broker?: MeshRelayBroker;
  private manager?: MeshRelayConnectorManager;
  private unsubscribe?: () => void;
  private refresh = Promise.resolve();
  private authorizationUpdate = Promise.resolve();
  private fingerprint?: string;
  private webSocketHandler?: ReturnType<typeof createRelayWebSocketHandler>;

  getBroker(): MeshRelayBroker {
    if (!this.broker) throw new DomainError("mesh_worker_connection_unavailable", "Controller worker connections are not running.");
    return this.broker;
  }

  getWebSocketHandler(): ReturnType<typeof createRelayWebSocketHandler> {
    if (!this.webSocketHandler) {
      throw new DomainError("mesh_worker_connection_unavailable", "Controller worker connections are not running.");
    }
    return this.webSocketHandler;
  }

  async startRuntime(dispatch: (request: Request) => Promise<Response | undefined>): Promise<void> {
    const identity = await ensureLocalMeshNodeIdentity();
    const key = await getLocalMeshSigningKey();
    this.fingerprint = identity.fingerprint;
    const broker = new MeshRelayBroker({
      identity: {
        publicKey: identity.publicKey,
        fingerprint: identity.fingerprint,
        createdAt: identity.createdAt,
        sign: (payload) => sign(null, Buffer.from(payload, "utf8"), key).toString("base64url"),
      },
      store: new MeshRelayStore(),
      controllerFingerprint: identity.fingerprint,
    });
    this.broker = broker;
    this.webSocketHandler = createRelayWebSocketHandler(broker);
    const manager = new MeshRelayConnectorManager({
      manageTransport: false,
      socketFactory: createMeshLocalBrokerSocketFactory(broker),
    });
    this.manager = manager;
    manager.start({
      config: {
        relayUrl: LOCAL_BROKER_ORIGIN,
        relayFingerprint: identity.fingerprint,
        role: "controller",
        protocolVersion: MESH_PROTOCOL_VERSION,
      },
      dispatch,
      refreshProtocol: async () => MESH_PROTOCOL_VERSION,
      onAuthenticated: () => {
        this.synchronizeAuthorization();
      },
    });
    this.unsubscribe = meshStateEventEmitter.subscribe((event) => {
      if (event.reason !== "health") this.synchronizeAuthorization();
    });
    setMeshOutboundTransport(createMeshStreamPeerTransport((route) => {
      if (!isMeshOutboundRoute(route)) throw new DomainError("mesh_transport_route_invalid", "An outbound worker route is required.");
      return manager.resolveConnector({
        kind: "relay",
        relayUrl: LOCAL_BROKER_ORIGIN,
        relayFingerprint: identity.fingerprint,
        targetNodeId: route.targetNodeId,
      });
    }));
    try {
      await manager.waitUntilConnected();
      await this.authorizationUpdate;
    } catch (error) {
      await this.stopRuntime();
      throw error;
    }
  }

  private synchronizeAuthorization(): void {
    const manager = this.manager;
    const fingerprint = this.fingerprint;
    if (!manager || !fingerprint) return;
    this.authorizationUpdate = this.refresh.then(async () => {
      if (this.manager !== manager || manager.status !== "connected") return;
      await manager.replaceAuthorization(listActiveControllerWorkerIdentities({
        relayUrl: LOCAL_BROKER_ORIGIN,
        relayFingerprint: fingerprint,
        directOutbound: true,
      }));
    });
    this.refresh = this.authorizationUpdate.catch((error: unknown) => {
      log.error("Outbound worker authorization could not be synchronized", { error: String(error) });
      manager.closeCurrentConnection(1011, "Worker authorization synchronization failed");
    });
  }

  async stopRuntime(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    setMeshOutboundTransport(null);
    const manager = this.manager;
    this.manager = undefined;
    try {
      await this.refresh;
      await manager?.stop();
    } finally {
      this.broker?.stop();
      // Physical socket close callbacks still use this broker-bound handler.
      this.broker = undefined;
      this.fingerprint = undefined;
    }
  }
}

export const controllerWorkerConnectionService = new ControllerWorkerConnectionService();
