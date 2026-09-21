/**
 * Worker-owned persistent relay connection lifecycle.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import type { MeshControllerGrant, MeshRelayPeerRoute } from "@/shared/mesh";
import { normalizeMeshRelayOrigin } from "@/shared/mesh-relay";
import { listControllerGrants } from "../persistence/mesh";
import { DomainError } from "../domain/domain-error";
import { MeshRelayConnectorManager } from "./mesh-relay-connector-manager";
import { requireMeshRuntimeRole } from "./mesh-runtime";

type RelayDispatch = (request: Request) => Promise<Response | undefined>;

const log = createLogger("core:worker-relay-service");

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
      "The active worker relay must use HTTPS unless it is a loopback origin.",
      { cause: error },
    );
  }
  for (const candidate of relayed) {
    try {
      normalizeMeshRelayOrigin(candidate.route.relayUrl);
    } catch (error) {
      throw new DomainError(
        "mesh_worker_relay_url_invalid",
        "The active worker relay must use HTTPS unless it is a loopback origin.",
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
      } catch (error) {
        await this.manager.stop();
        log.error("Worker relay runtime could not be started", {
          error: String(error),
        });
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
    await this.runLifecycle(async () => {
      await this.manager.stop();
      this.dispatch = undefined;
    });
  }

  private async reconcile(): Promise<void> {
    const selected = activeRelayGrant(await listControllerGrants());
    if (!selected) {
      await this.manager.stop();
      return;
    }
    const expected = {
      relayUrl: selected.route.relayUrl,
      relayFingerprint: selected.route.relayFingerprint,
      role: "worker" as const,
      targetNodeId: selected.grant.controllerNodeId,
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
      dispatch: this.dispatch!,
      shouldMaintain: async () => {
        const current = activeRelayGrant(await listControllerGrants());
        return current !== null
          && current.grant.controllerNodeId === selected.grant.controllerNodeId
          && current.route.relayUrl === selected.route.relayUrl
          && current.route.relayFingerprint === selected.route.relayFingerprint;
      },
    });
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
