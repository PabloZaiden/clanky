/**
 * Worker-owned persistent outbound connection lifecycle.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import { isMeshOutboundRoute, type MeshControllerGrant, type MeshRelayPeerRoute } from "@/shared/mesh";
import { normalizeMeshRelayOrigin } from "@/shared/mesh-relay";
import { listControllerGrants } from "../persistence/mesh";
import { DomainError } from "../domain/domain-error";
import { MeshRelayConnectorManager } from "./mesh-relay-connector-manager";
import { requireMeshRuntimeRole } from "./mesh-runtime";
import { discoverMeshEnrollmentTarget } from "./mesh-target-discovery";
import { negotiateMeshDescriptorGeneration } from "./mesh-protocol-version";
import { MESH_PROTOCOL_VERSION, meshTransportProtocolVersions } from "@/shared/mesh-protocol";
import { setMeshOutboundTransport } from "./mesh-peer-transport";
import { createMeshStreamPeerTransport } from "./mesh-relay-transport";

type RelayDispatch = (request: Request) => Promise<Response | undefined>;

const log = createLogger("core:worker-relay-service");
const GRANT_REFRESH_INTERVAL_MS = 5_000;

function activeRelayGrant(
  grants: MeshControllerGrant[],
): { grant: MeshControllerGrant; route: MeshRelayPeerRoute } | null {
  const relayed = grants.flatMap((grant) => (
    grant.grantStatus === "active" && grant.controllerRoute?.kind === "relay"
      ? [{ grant, route: grant.controllerRoute }]
      : []
  ));
  if (relayed.length === 0) {
    return null;
  }
  const first = relayed[0]!;
  try {
    normalizeMeshRelayOrigin(first.route.relayUrl);
  } catch (error) {
    throw new DomainError(
      "mesh_worker_relay_url_invalid",
      "The active worker relay must use HTTPS.",
      { cause: error },
    );
  }
  for (const candidate of relayed) {
    try {
      normalizeMeshRelayOrigin(candidate.route.relayUrl);
    } catch (error) {
      throw new DomainError(
        "mesh_worker_relay_url_invalid",
        "The active worker relay must use HTTPS.",
        { cause: error },
      );
    }
    if (
      candidate.grant.controllerNodeId !== first.grant.controllerNodeId
      || candidate.route.targetNodeId !== first.route.targetNodeId
      || candidate.route.relayUrl !== first.route.relayUrl
      || candidate.route.relayFingerprint !== first.route.relayFingerprint
    ) {
      throw new DomainError(
        "mesh_worker_relay_grants_inconsistent",
        "Active relay controller grants disagree on the relay or target controller.",
      );
    }
  }
  if (first.route.targetNodeId !== first.grant.controllerNodeId) {
    throw new DomainError(
      "mesh_worker_relay_grants_inconsistent",
      "The active relay route targets a different controller than its grant.",
    );
  }
  return first;
}

export class WorkerRelayService {
  private dispatch?: RelayDispatch;
  private lifecycle = Promise.resolve();
  private refreshTimer?: ReturnType<typeof setInterval>;
  private periodicRefresh?: Promise<void>;
  private readonly directManagers = new Map<string, {
    manager: MeshRelayConnectorManager;
    endpoint: string;
    fingerprint: string;
  }>();

  constructor(
    private readonly manager: MeshRelayConnectorManager =
      new MeshRelayConnectorManager(),
  ) {}

  async startRuntime(dispatch: RelayDispatch): Promise<void> {
    await this.runLifecycle(async () => {
      requireMeshRuntimeRole("worker");
      this.dispatch = dispatch;
      try {
        await this.reconcile();
        clearInterval(this.refreshTimer);
        // CLI enrollment persists grants in another process.
        this.refreshTimer = setInterval(() => {
          if (this.periodicRefresh) return;
          const refresh = this.refresh().catch((error: unknown) => {
            log.error("Worker outbound grants could not be refreshed", {
              error: String(error),
            });
          }).finally(() => {
            if (this.periodicRefresh === refresh) this.periodicRefresh = undefined;
          });
          this.periodicRefresh = refresh;
        }, GRANT_REFRESH_INTERVAL_MS);
        this.refreshTimer.unref();
      } catch (error) {
        await this.stopConnections();
        log.error("Worker relay runtime could not be started", {
          error: String(error),
        });
        throw error;
      }
    });
  }

  async refresh(): Promise<void> {
    await this.runLifecycle(async () => {
      if (!this.dispatch) {
        return;
      }
      requireMeshRuntimeRole("worker");
      await this.reconcile();
    });
  }

  async assertRouteCompatible(
    controllerNodeId: string,
    route: MeshRelayPeerRoute,
  ): Promise<void> {
    const selected = activeRelayGrant(await listControllerGrants());
    if (
      selected
      && selected.grant.controllerNodeId !== controllerNodeId
    ) {
      throw new DomainError(
        "mesh_worker_relay_grants_inconsistent",
        "A worker may have only one active relay controller association.",
      );
    }
    if (route.targetNodeId !== controllerNodeId) {
      throw new DomainError(
        "mesh_worker_relay_grants_inconsistent",
        "The relay route must target the controller that owns the grant.",
      );
    }
  }

  async stopRuntime(): Promise<void> {
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    await this.runLifecycle(async () => {
      await this.stopConnections();
      this.dispatch = undefined;
    });
  }

  private async reconcile(): Promise<void> {
    const grants = await listControllerGrants();
    await this.reconcileDirect(grants);
    const selected = activeRelayGrant(grants);
    if (!selected) {
      await this.manager.stop();
      return;
    }
    const refreshProtocol = async () => {
      const discovered = await discoverMeshEnrollmentTarget(selected.route.relayUrl);
      if (discovered.descriptor.role !== "relay"
        || discovered.descriptor.fingerprint !== selected.route.relayFingerprint
        || discovered.descriptor.controllerNodeId !== selected.grant.controllerNodeId
        || discovered.descriptor.controllerFingerprint !== selected.grant.controllerFingerprint
      ) throw new DomainError("mesh_worker_relay_grants_inconsistent", "Relay discovery does not match the enrolled controller route.");
      const version = negotiateMeshDescriptorGeneration(discovered.descriptor, meshTransportProtocolVersions(selected.route.relayUrl));
      if (!version) throw new DomainError("mesh_execution_protocol_mismatch", "The worker and relay have no supported generation.");
      return version;
    };
    const expected = {
      relayUrl: selected.route.relayUrl,
      relayFingerprint: selected.route.relayFingerprint,
      role: "worker" as const,
      targetNodeId: selected.grant.controllerNodeId,
      // Only a seed: the manager discovers the version before opening a socket.
      protocolVersion: selected.grant.controllerNegotiatedProtocolVersion ?? MESH_PROTOCOL_VERSION,
    };
    const active = this.manager.activeConfig;
    if (
      active
      && active.relayUrl === expected.relayUrl
      && active.relayFingerprint === expected.relayFingerprint
      && active.role === expected.role
      && active.targetNodeId === expected.targetNodeId
    ) {
      return;
    }
    await this.manager.stop();
    this.manager.start({
      config: expected,
      refreshProtocol,
      dispatch: this.dispatch!,
      shouldMaintain: async () => {
        const current = activeRelayGrant(await listControllerGrants());
        return current !== null
          && current.grant.controllerNodeId === selected.grant.controllerNodeId
          && current.route.relayUrl === selected.route.relayUrl
          && current.route.relayFingerprint === selected.route.relayFingerprint
          && current.route.targetNodeId === expected.targetNodeId;
      },
    });
  }

  private async reconcileDirect(grants: MeshControllerGrant[]): Promise<void> {
    const active = grants.filter((grant) => grant.grantStatus === "active" && isMeshOutboundRoute(grant.controllerRoute));
    for (const [id, runtime] of this.directManagers) {
      const grant = active.find((candidate) => candidate.controllerNodeId === id);
      if (!runtime.manager.activeConfig || !grant || !isMeshOutboundRoute(grant.controllerRoute)
        || grant.controllerRoute.endpoint !== runtime.endpoint
        || grant.controllerFingerprint !== runtime.fingerprint) {
        await runtime.manager.stop();
        this.directManagers.delete(id);
      }
    }
    for (const grant of active) {
      const route = grant.controllerRoute;
      if (!isMeshOutboundRoute(route)) continue;
      if (route.targetNodeId !== grant.controllerNodeId) {
        throw new DomainError("mesh_enrollment_controller_mismatch", "The outbound route targets a different controller than its grant.");
      }
      if (this.directManagers.has(grant.controllerNodeId)) continue;
      const manager = new MeshRelayConnectorManager({ manageTransport: false });
      this.directManagers.set(grant.controllerNodeId, {
        manager, endpoint: route.endpoint, fingerprint: grant.controllerFingerprint,
      });
      manager.start({
        config: {
          relayUrl: route.endpoint, relayFingerprint: grant.controllerFingerprint,
          role: "worker", targetNodeId: grant.controllerNodeId,
          protocolVersion: grant.controllerNegotiatedProtocolVersion ?? MESH_PROTOCOL_VERSION,
        },
        dispatch: this.dispatch!,
        refreshProtocol: async () => {
          const discovered = await discoverMeshEnrollmentTarget(route.endpoint, { outboundWorker: true });
          if (discovered.descriptor.role !== "controller"
            || discovered.descriptor.outboundWorker !== 1
            || discovered.descriptor.nodeId !== grant.controllerNodeId
            || discovered.descriptor.fingerprint !== grant.controllerFingerprint
            || discovered.descriptor.publicKey !== grant.controllerPublicKey) {
            throw new DomainError("mesh_enrollment_controller_mismatch", "Controller discovery does not match the outbound worker grant.");
          }
          return discovered.negotiatedProtocolVersion;
        },
        shouldMaintain: async () => (await listControllerGrants()).some((candidate) => (
          candidate.grantStatus === "active" && candidate.controllerNodeId === grant.controllerNodeId
          && candidate.controllerFingerprint === grant.controllerFingerprint
          && isMeshOutboundRoute(candidate.controllerRoute)
          && candidate.controllerRoute.endpoint === route.endpoint
        )),
      });
    }
    setMeshOutboundTransport(this.directManagers.size ? createMeshStreamPeerTransport((route) => {
      if (!isMeshOutboundRoute(route)) throw new DomainError("mesh_transport_route_invalid", "An outbound controller route is required.");
      const runtime = this.directManagers.get(route.targetNodeId);
      if (!runtime || runtime.endpoint !== route.endpoint) {
        throw new DomainError("mesh_worker_connection_unavailable", "The outbound controller connection is not available.");
      }
      return runtime.manager.resolveConnector({
        kind: "relay", targetNodeId: route.targetNodeId,
        relayUrl: runtime.endpoint, relayFingerprint: runtime.fingerprint,
      });
    }) : null);
  }

  private async stopConnections(): Promise<void> {
    setMeshOutboundTransport(null);
    await Promise.all([
      this.manager.stop(),
      ...[...this.directManagers.values()].map((runtime) => runtime.manager.stop()),
    ]);
    this.directManagers.clear();
  }

  private async runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycle;
    let release!: () => void;
    this.lifecycle = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export const workerRelayService = new WorkerRelayService();
