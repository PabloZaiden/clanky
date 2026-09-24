/**
 * Controller-owned relay pairing and persistent connection lifecycle.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import {
  ControllerRelayNameSchema,
  MeshRelayWellKnownDescriptorSchema,
  type ControllerRelayPairingStatus,
  type ControllerRelayStatusItem,
} from "@/contracts/schemas/mesh-relay";
import {
  MESH_RELAY_DESCRIPTOR_PATH,
  normalizeMeshRelayOrigin,
  type MeshRelayPeerIdentity,
  type MeshRelayWellKnownDescriptorV5,
} from "@/shared/mesh-relay";
import { MESH_PROTOCOL_VERSIONS_HEADER, serializeMeshProtocolVersions } from "@/shared/mesh-protocol";
import { MESH_PROTOCOL_VERSION } from "@/shared/mesh-protocol";
import type { MeshEnrollmentRoute } from "@/contracts/schemas/mesh";
import type { MeshRelayPeerRoute } from "@/shared/mesh";
import {
  deleteControllerRelayPairing,
  getControllerRelayPairing,
  getPrimaryControllerRelayPairing,
  InconsistentMeshWorkerIdentityError,
  listActiveControllerWorkerIdentities,
  listControllerRelayPairings,
  restoreControllerRelayPairing,
  saveControllerRelayPairing,
  setPrimaryControllerRelayPairing,
  type ControllerRelayPairing,
} from "../persistence/controller-relay-pairing";
import {
  ensureLocalMeshNodeIdentity,
} from "../persistence/mesh-node-identity";
import { DomainError } from "../domain/domain-error";
import { meshStateEventEmitter } from "./event-emitter";
import {
  MeshRelayConnector,
  type MeshRelayConnectorOptions,
  validateMeshRelayAuthorization,
} from "./mesh-relay-connector";
import { MeshRelayStreamError } from "./mesh-relay-errors";
import {
  MeshRelayConnectorManager,
} from "./mesh-relay-connector-manager";
import { setMeshRelayTransport } from "./mesh-peer-transport";
import { createMeshRelayPeerTransport } from "./mesh-relay-transport";
import { requireMeshRuntimeRole } from "./mesh-runtime";

const log = createLogger("core:controller-relay-service");

export const CONTROLLER_RELAY_DESCRIPTOR_TIMEOUT_MS = 10_000;
export const CONTROLLER_RELAY_DESCRIPTOR_MAX_BYTES = 64 * 1024;
export const CONTROLLER_RELAY_CONNECTION_TIMEOUT_MS = 30_000;
export const RELAY_CONTROLLER_FINGERPRINT_ENV =
  "CLANKY_RELAY_CONTROLLER_FINGERPRINT";

export type ControllerRelayStatus = ControllerRelayPairingStatus;

export interface MeshEnrollmentInvitationTarget {
  route: MeshEnrollmentRoute;
  target: string;
  relay?: {
    relayUrl: string;
    relayFingerprint: string;
  };
}

export interface ControllerRelayServiceOptions {
  fetchFn?: typeof fetch;
  manager?: MeshRelayConnectorManager;
  createConnector?(options: MeshRelayConnectorOptions): MeshRelayConnector;
  descriptorTimeoutMs?: number;
  descriptorMaxBytes?: number;
}

export interface ControllerRelayRuntimeOptions {
  onAuthenticated?(): void;
}

type RelayDispatch = (request: Request) => Promise<Response | undefined>;

interface AuthorizationWaiter {
  resolve(): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

interface ControllerRelayRuntime {
  manager: MeshRelayConnectorManager;
  authorizationDirty: boolean;
  authorizationRefresh?: Promise<void>;
  authorizationWaiters: Set<AuthorizationWaiter>;
  runtimeError: ControllerRelayStatusItem["runtimeError"];
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new DomainError(
      "mesh_relay_descriptor_too_large",
      "The Mesh relay descriptor exceeds the allowed size.",
    );
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new DomainError(
          "mesh_relay_descriptor_too_large",
          "The Mesh relay descriptor exceeds the allowed size.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function pairingStatus(
  pairing: ControllerRelayPairing,
  connected: boolean,
  runtimeError: ControllerRelayStatusItem["runtimeError"],
): ControllerRelayStatusItem {
  return {
    name: pairing.name,
    isPrimary: pairing.isPrimary,
    relayUrl: pairing.relayUrl,
    relayFingerprint: pairing.relayFingerprint,
    connected,
    runtimeError,
    pairedAt: pairing.pairedAt,
    updatedAt: pairing.updatedAt,
    relayBinaryVersion: pairing.relayBinaryVersion,
    relaySupportedProtocolVersions: pairing.relaySupportedProtocolVersions,
    relayPreferredProtocolVersion: pairing.relayPreferredProtocolVersion,
    relayNegotiatedProtocolVersion: pairing.relayNegotiatedProtocolVersion,
  };
}

export class ControllerRelayService {
  private readonly runtimes = new Map<string, ControllerRelayRuntime>();
  private dispatch?: RelayDispatch;
  private unsubscribeMesh?: () => void;
  private lifecycle = Promise.resolve();
  private usedInjectedManager = false;
  private onAuthenticated?: () => void;

  constructor(private readonly options: ControllerRelayServiceOptions = {}) {}

  async getStatus(): Promise<ControllerRelayStatus> {
    requireMeshRuntimeRole("controller");
    const identity = await ensureLocalMeshNodeIdentity();
    const pairings = listControllerRelayPairings();
    return {
      controllerFingerprint: identity.fingerprint,
      bootstrapEnvironment:
        `${RELAY_CONTROLLER_FINGERPRINT_ENV}=${identity.fingerprint}`,
      primaryName: pairings.find((pairing) => pairing.isPrimary)?.name ?? null,
      relays: pairings.map((pairing) => {
        const runtime = this.runtimes.get(pairing.name);
        return pairingStatus(
          pairing,
          runtime?.manager.status === "connected",
          runtime?.runtimeError ?? null,
        );
      }),
    };
  }

  async resolveEnrollmentInvitationTarget(
    route: MeshEnrollmentRoute,
    directTarget: string,
    relayName?: string,
  ): Promise<MeshEnrollmentInvitationTarget> {
    requireMeshRuntimeRole("controller");
    if (route === "direct") {
      if (relayName !== undefined) {
        throw new DomainError(
          "mesh_relay_name_invalid",
          "A relay can only be selected for a relay enrollment.",
        );
      }
      return { route, target: directTarget };
    }
    const pairing = relayName === undefined
      ? getPrimaryControllerRelayPairing()
      : getControllerRelayPairing(this.normalizeRelayName(relayName));
    if (!pairing) {
      throw new DomainError(
        relayName === undefined ? "mesh_relay_not_paired" : "mesh_relay_not_found",
        relayName === undefined
          ? "Select a primary relay before creating a relay enrollment invitation."
          : "The selected controller relay is not paired.",
      );
    }
    const identity = await ensureLocalMeshNodeIdentity();
    if (
      pairing.controllerNodeId !== identity.nodeId
      || pairing.controllerFingerprint !== identity.fingerprint
    ) {
      throw new DomainError(
        "mesh_relay_controller_identity_changed",
        "The persisted relay pairing belongs to a different controller identity.",
      );
    }
    return {
      route,
      target: pairing.relayUrl,
      relay: {
        relayUrl: pairing.relayUrl,
        relayFingerprint: pairing.relayFingerprint,
      },
    };
  }

  getDedicatedWorkerEnrollmentRoute(): MeshEnrollmentRoute {
    requireMeshRuntimeRole("controller");
    return getPrimaryControllerRelayPairing() ? "relay" : "direct";
  }

  assertEnrollmentRelayRoute(route: {
    relayUrl: string;
    relayFingerprint: string;
  }): ControllerRelayPairing {
    requireMeshRuntimeRole("controller");
    const pairing = listControllerRelayPairings().find(
      (candidate) => candidate.relayUrl === route.relayUrl
        && candidate.relayFingerprint === route.relayFingerprint,
    );
    if (!pairing) {
      throw new DomainError(
        "mesh_enrollment_relay_mismatch",
        "The enrollment relay route does not match a controller pairing.",
      );
    }
    return pairing;
  }

  async pair(name: string, relayUrl: string): Promise<ControllerRelayStatus> {
    return await this.runLifecycle(async () => {
      requireMeshRuntimeRole("controller");
      name = this.normalizeRelayName(name);
      const normalizedRelayUrl = this.normalizeRelayUrl(relayUrl);
      const identity = await ensureLocalMeshNodeIdentity();
      const descriptor = await this.fetchDescriptor(normalizedRelayUrl);
      if (descriptor.controllerFingerprint !== identity.fingerprint) {
        throw new DomainError(
          "mesh_relay_controller_mismatch",
          "The relay is configured for a different controller fingerprint.",
        );
      }
      if (listControllerRelayPairings().some((pairing) => (
        pairing.name !== name
        && (
          pairing.relayUrl === normalizedRelayUrl
          || pairing.relayFingerprint === descriptor.fingerprint
        )
      ))) {
        throw new DomainError(
          "mesh_relay_already_paired",
          "The relay is already paired under another name.",
        );
      }

      const connectorFactory = this.options.createConnector
        ?? ((options: MeshRelayConnectorOptions) => new MeshRelayConnector(options));
      const connector = connectorFactory({
        config: {
          relayUrl: normalizedRelayUrl,
          relayFingerprint: descriptor.fingerprint,
          role: "controller",
          protocolVersion: MESH_PROTOCOL_VERSION,
        },
      });
      try {
        await connector.connect();
      } catch (error) {
        throw new DomainError(
          "mesh_relay_pairing_auth_failed",
          "The controller could not authenticate with the relay.",
          { cause: error },
        );
      } finally {
        connector.close(1000, "Controller relay pairing authentication complete");
      }

      const previousPairing = getControllerRelayPairing(name);
      const pairing = saveControllerRelayPairing({
        name,
        relayUrl: normalizedRelayUrl,
        relayPublicKey: descriptor.publicKey,
        relayFingerprint: descriptor.fingerprint,
        controllerNodeId: identity.nodeId,
        controllerFingerprint: identity.fingerprint,
        relayBinaryVersion: descriptor.binaryVersion,
        relaySupportedProtocolVersions: descriptor.supportedProtocolVersions,
        relayPreferredProtocolVersion: descriptor.preferredProtocolVersion,
        relayNegotiatedProtocolVersion: descriptor.negotiatedProtocolVersion,
      });
      const runtime = this.dispatch ? this.getOrCreateRuntime(name) : undefined;
      if (runtime) {
        runtime.runtimeError = null;
      }
      if (this.dispatch) {
        try {
          await this.restartManager(runtime!, pairing, true);
        } catch (error) {
          await this.stopManager(runtime!);
          if (previousPairing) {
            restoreControllerRelayPairing(previousPairing);
            try {
              await this.restartManager(runtime!, previousPairing, false);
            } catch (restoreError) {
              this.setRuntimeError(runtime!, restoreError);
              log.error("Previous controller relay runtime could not be restored", {
                relayName: name,
                error: String(restoreError),
              });
            }
          } else {
            deleteControllerRelayPairing(name);
            this.runtimes.delete(name);
          }
          throw error;
        }
      }
      return await this.getStatus();
    });
  }

  async unpair(name: string): Promise<ControllerRelayStatus> {
    return await this.runLifecycle(async () => {
      requireMeshRuntimeRole("controller");
      name = this.normalizeRelayName(name);
      if (!getControllerRelayPairing(name)) {
        throw new DomainError("mesh_relay_not_found", "The controller relay is not paired.");
      }
      const runtime = this.runtimes.get(name);
      if (runtime) {
        await this.stopManager(runtime);
        this.runtimes.delete(name);
      }
      deleteControllerRelayPairing(name);
      return await this.getStatus();
    });
  }

  async selectPrimary(name: string): Promise<ControllerRelayStatus> {
    return await this.runLifecycle(async () => {
      requireMeshRuntimeRole("controller");
      name = this.normalizeRelayName(name);
      if (!setPrimaryControllerRelayPairing(name)) {
        throw new DomainError("mesh_relay_not_found", "The controller relay is not paired.");
      }
      return await this.getStatus();
    });
  }

  async startRuntime(
    dispatch: RelayDispatch,
    options: ControllerRelayRuntimeOptions = {},
  ): Promise<void> {
    await this.runLifecycle(async () => {
      requireMeshRuntimeRole("controller");
      this.dispatch = dispatch;
      this.onAuthenticated = options.onAuthenticated;
      this.unsubscribeMesh ??= meshStateEventEmitter.subscribe(() => {
        this.requestRuntimeRefresh();
      });
      setMeshRelayTransport(createMeshRelayPeerTransport(
        (route) => this.resolveConnector(route),
      ));
      for (const pairing of listControllerRelayPairings()) {
        const runtime = this.getOrCreateRuntime(pairing.name);
        try {
          await this.restartManager(runtime, pairing, false);
        } catch (error) {
          await this.stopManager(runtime);
          this.setRuntimeError(runtime, error);
          log.error("Controller relay runtime could not be started", {
            relayName: pairing.name,
            error: String(error),
          });
        }
      }
    });
  }

  async stopRuntime(): Promise<void> {
    await this.runLifecycle(async () => {
      this.unsubscribeMesh?.();
      this.unsubscribeMesh = undefined;
      await Promise.all(
        [...this.runtimes.values()].map((runtime) => this.stopManager(runtime)),
      );
      this.runtimes.clear();
      this.usedInjectedManager = false;
      setMeshRelayTransport(null);
      this.dispatch = undefined;
      this.onAuthenticated = undefined;
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

  private normalizeRelayUrl(value: string): string {
    try {
      return normalizeMeshRelayOrigin(value);
    } catch (error) {
      throw new DomainError(
        "mesh_relay_url_invalid",
        error instanceof Error
          ? error.message
          : "Relay URL must be a valid HTTPS origin.",
        { cause: error },
      );
    }
  }

  private normalizeRelayName(value: string): string {
    const parsed = ControllerRelayNameSchema.safeParse(value);
    if (!parsed.success) {
      throw new DomainError(
        "mesh_relay_name_invalid",
        "Relay name must use 1-64 letters, numbers, hyphens, or underscores.",
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }

  private getOrCreateRuntime(name: string): ControllerRelayRuntime {
    const existing = this.runtimes.get(name);
    if (existing) {
      return existing;
    }
    const manager = this.options.manager && !this.usedInjectedManager
      ? this.options.manager
      : new MeshRelayConnectorManager({ manageTransport: false });
    this.usedInjectedManager = true;
    const runtime: ControllerRelayRuntime = {
      manager,
      authorizationDirty: false,
      authorizationWaiters: new Set<AuthorizationWaiter>(),
      runtimeError: null,
    };
    this.runtimes.set(name, runtime);
    return runtime;
  }

  private resolveConnector(route: MeshRelayPeerRoute): MeshRelayConnector {
    const runtime = [...this.runtimes.values()].find((candidate) => {
      const config = candidate.manager.activeConfig;
      return config?.relayUrl === route.relayUrl
        && config.relayFingerprint === route.relayFingerprint;
    });
    if (!runtime) {
      throw new DomainError(
        "mesh_relay_unavailable",
        "No configured Mesh relay connection matches this worker's route.",
      );
    }
    return runtime.manager.resolveConnector(route);
  }

  private async fetchDescriptor(
    relayUrl: string,
  ): Promise<MeshRelayWellKnownDescriptorV5> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.descriptorTimeoutMs
        ?? CONTROLLER_RELAY_DESCRIPTOR_TIMEOUT_MS,
    );
    timer.unref?.();
    try {
      const response = await (this.options.fetchFn ?? fetch)(
        new URL(MESH_RELAY_DESCRIPTOR_PATH, `${relayUrl}/`),
        {
          method: "GET",
          headers: {
            accept: "application/json",
            [MESH_PROTOCOL_VERSIONS_HEADER]: serializeMeshProtocolVersions(),
          },
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new DomainError(
          "mesh_relay_descriptor_rejected",
          "The Mesh relay descriptor request was rejected.",
          { details: { status: response.status } },
        );
      }
      let raw: unknown;
      try {
        const body = await readBoundedBody(
          response,
          this.options.descriptorMaxBytes
            ?? CONTROLLER_RELAY_DESCRIPTOR_MAX_BYTES,
        );
        raw = JSON.parse(body) as unknown;
      } catch (error) {
        if (controller.signal.aborted) {
          throw new DomainError(
            "mesh_relay_descriptor_unreachable",
            "The Mesh relay descriptor request timed out.",
            { cause: error },
          );
        }
        if (error instanceof DomainError) {
          throw error;
        }
        throw new DomainError(
          "mesh_relay_descriptor_invalid",
          "The Mesh relay descriptor is not valid JSON.",
          { cause: error },
        );
      }
      const parsed = MeshRelayWellKnownDescriptorSchema.safeParse(raw);
      if (!parsed.success) {
        throw new DomainError(
          "mesh_relay_descriptor_invalid",
          "The Mesh relay descriptor is incompatible or invalid.",
          { cause: parsed.error },
        );
      }
      if (parsed.data.negotiatedProtocolVersion !== MESH_PROTOCOL_VERSION) {
        throw new DomainError(
          "mesh_relay_descriptor_invalid",
          "The Mesh relay does not negotiate the required protocol generation.",
        );
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      throw new DomainError(
        "mesh_relay_descriptor_unreachable",
        "The Mesh relay descriptor could not be reached.",
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async refreshPairingProtocol(
    pairing: ControllerRelayPairing,
  ): Promise<ControllerRelayPairing> {
    let descriptor: MeshRelayWellKnownDescriptorV5;
    try {
      descriptor = await this.fetchDescriptor(pairing.relayUrl);
    } catch (error) {
      log.warn("Could not renegotiate the persisted relay pairing", {
        relayUrl: pairing.relayUrl,
        error: String(error),
      });
      return pairing;
    }
    if (
      descriptor.fingerprint !== pairing.relayFingerprint
      || descriptor.controllerFingerprint !== pairing.controllerFingerprint
    ) {
      return pairing;
    }
    const metadata = {
      relayBinaryVersion: descriptor.binaryVersion,
      relaySupportedProtocolVersions: descriptor.supportedProtocolVersions,
      relayPreferredProtocolVersion: descriptor.preferredProtocolVersion,
      relayNegotiatedProtocolVersion: descriptor.negotiatedProtocolVersion,
    };
    if (
      pairing.relayBinaryVersion === metadata.relayBinaryVersion
      && JSON.stringify(pairing.relaySupportedProtocolVersions)
        === JSON.stringify(metadata.relaySupportedProtocolVersions)
      && pairing.relayPreferredProtocolVersion
        === metadata.relayPreferredProtocolVersion
      && pairing.relayNegotiatedProtocolVersion
        === metadata.relayNegotiatedProtocolVersion
    ) {
      return pairing;
    }
    return saveControllerRelayPairing({
      name: pairing.name,
      relayUrl: pairing.relayUrl,
      relayPublicKey: pairing.relayPublicKey,
      relayFingerprint: pairing.relayFingerprint,
      controllerNodeId: pairing.controllerNodeId,
      controllerFingerprint: pairing.controllerFingerprint,
      ...metadata,
    });
  }

  private async restartManager(
    runtime: ControllerRelayRuntime,
    pairing: ControllerRelayPairing,
    waitForConnection: boolean,
  ): Promise<void> {
    await this.stopManager(runtime);
    pairing = await this.refreshPairingProtocol(pairing);
    const relayUrl = this.normalizeRelayUrl(pairing.relayUrl);
    const dispatch = this.dispatch;
    if (!dispatch) {
      return;
    }
    const identity = await ensureLocalMeshNodeIdentity();
    if (
      pairing.controllerNodeId !== identity.nodeId
      || pairing.controllerFingerprint !== identity.fingerprint
    ) {
      throw new DomainError(
        "mesh_relay_controller_identity_changed",
        "The persisted relay pairing belongs to a different controller identity.",
      );
    }
    // Validate before connecting so deterministic local snapshot corruption
    // cannot enter the manager's reconnect loop.
    this.loadAuthorizationWorkers({
      relayUrl,
      relayFingerprint: pairing.relayFingerprint,
    });
    runtime.runtimeError = null;
    runtime.authorizationDirty = true;
    runtime.manager.start({
      config: {
        relayUrl,
        relayFingerprint: pairing.relayFingerprint,
        role: "controller",
        protocolVersion: MESH_PROTOCOL_VERSION,
      },
      dispatch,
      onAuthenticated: () => {
        runtime.authorizationDirty = true;
        this.requestAuthorizationRefresh(runtime);
        try {
          this.onAuthenticated?.();
        } catch (error) {
          log.error("Controller relay authentication callback failed", {
            error: String(error),
          });
        }
      },
    });
    if (waitForConnection) {
      await runtime.manager.waitUntilConnected(CONTROLLER_RELAY_CONNECTION_TIMEOUT_MS);
      this.requestAuthorizationRefresh(runtime);
      await this.waitUntilAuthorizationSynchronized(
        runtime,
        CONTROLLER_RELAY_CONNECTION_TIMEOUT_MS,
      );
    }
  }

  private requestAuthorizationRefresh(runtime: ControllerRelayRuntime): void {
    runtime.authorizationDirty = true;
    if (
      runtime.authorizationRefresh
      || runtime.manager.status !== "connected"
    ) {
      return;
    }
    runtime.authorizationRefresh = this.refreshAuthorization(runtime)
      .finally(() => {
        runtime.authorizationRefresh = undefined;
        if (runtime.authorizationDirty && runtime.manager.status === "connected") {
          this.requestAuthorizationRefresh(runtime);
        } else if (
          !runtime.authorizationDirty
          && runtime.manager.status === "connected"
        ) {
          this.resolveAuthorizationWaiters(runtime);
        }
      });
  }

  private requestRuntimeRefresh(): void {
    void this.runLifecycle(async () => {
      if (!this.dispatch) {
        return;
      }
      for (const pairing of listControllerRelayPairings()) {
        const runtime = this.getOrCreateRuntime(pairing.name);
        if (runtime.manager.activeConfig) {
          this.requestAuthorizationRefresh(runtime);
          continue;
        }
        try {
          await this.restartManager(runtime, pairing, false);
        } catch (error) {
          await this.stopManager(runtime);
          this.setRuntimeError(runtime, error);
          log.error("Controller relay runtime could not be refreshed", {
            relayName: pairing.name,
            error: String(error),
          });
        }
      }
    }).catch((error: unknown) => {
      log.error("Controller relay runtime refresh failed", {
        error: String(error),
      });
    });
  }

  private async refreshAuthorization(runtime: ControllerRelayRuntime): Promise<void> {
    while (
      runtime.authorizationDirty
      && runtime.manager.status === "connected"
    ) {
      runtime.authorizationDirty = false;
      let workers: MeshRelayPeerIdentity[];
      try {
        const config = runtime.manager.activeConfig;
        if (!config) {
          return;
        }
        workers = this.loadAuthorizationWorkers({
          relayUrl: config.relayUrl,
          relayFingerprint: config.relayFingerprint,
        });
      } catch (error) {
        const mapped = this.mapRuntimeError(error);
        runtime.runtimeError = {
          code: mapped.code,
          message: mapped.message,
        };
        this.rejectAuthorizationWaiters(runtime, mapped);
        log.error("Controller relay authorization snapshot is invalid", {
          error: String(mapped),
        });
        return;
      }
      try {
        await runtime.manager.replaceAuthorization(workers);
        runtime.runtimeError = null;
      } catch (error) {
        if (
          error instanceof MeshRelayStreamError
          && error.status >= 400
          && error.status < 500
        ) {
          const mapped = this.mapRuntimeError(error);
          runtime.runtimeError = {
            code: mapped.code,
            message: mapped.message,
          };
          this.rejectAuthorizationWaiters(runtime, mapped);
          log.error("Controller relay rejected the authorization snapshot", {
            error: String(mapped),
          });
          return;
        }
        runtime.authorizationDirty = true;
        log.warn("Controller relay authorization refresh was ambiguous", {
          error: String(error),
        });
        runtime.manager.closeCurrentConnection(
          1011,
          "Relay authorization synchronization failed",
        );
        return;
      }
    }
  }

  private async stopManager(runtime: ControllerRelayRuntime): Promise<void> {
    await runtime.manager.stop();
    await runtime.authorizationRefresh;
    runtime.authorizationRefresh = undefined;
    runtime.authorizationDirty = false;
    this.rejectAuthorizationWaiters(runtime, new DomainError(
      "mesh_relay_disconnected",
      "The Mesh relay connection was stopped.",
    ));
  }

  private loadAuthorizationWorkers(route: {
    relayUrl: string;
    relayFingerprint: string;
  }): MeshRelayPeerIdentity[] {
    const workers = listActiveControllerWorkerIdentities(route);
    validateMeshRelayAuthorization(workers);
    return workers;
  }

  private mapRuntimeError(error: unknown): DomainError {
    if (error instanceof InconsistentMeshWorkerIdentityError) {
      return new DomainError(
        error.code,
        "Active worker registrations contain conflicting identities.",
        { cause: error, details: { nodeId: error.nodeId } },
      );
    }
    if (error instanceof DomainError) {
      return error;
    }
    if (error instanceof MeshRelayStreamError) {
      return new DomainError(error.code, error.message, { cause: error });
    }
    return new DomainError(
      "mesh_relay_runtime_invalid",
      "The persisted Mesh relay runtime configuration is invalid.",
      { cause: error },
    );
  }

  private setRuntimeError(runtime: ControllerRelayRuntime, error: unknown): void {
    const mapped = this.mapRuntimeError(error);
    runtime.runtimeError = {
      code: mapped.code,
      message: mapped.message,
    };
  }

  private async waitUntilAuthorizationSynchronized(
    runtime: ControllerRelayRuntime,
    timeoutMs: number,
  ): Promise<void> {
    if (
      runtime.manager.status === "connected"
      && !runtime.authorizationDirty
      && !runtime.authorizationRefresh
    ) {
      return;
    }
    return await new Promise<void>((resolve, reject) => {
      const waiter: AuthorizationWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          runtime.authorizationWaiters.delete(waiter);
          reject(new DomainError(
            "mesh_relay_authorization_failed",
            "The relay worker authorization snapshot could not be synchronized.",
          ));
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      runtime.authorizationWaiters.add(waiter);
    });
  }

  private resolveAuthorizationWaiters(runtime: ControllerRelayRuntime): void {
    for (const waiter of [...runtime.authorizationWaiters]) {
      runtime.authorizationWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private rejectAuthorizationWaiters(
    runtime: ControllerRelayRuntime,
    error: unknown,
  ): void {
    for (const waiter of [...runtime.authorizationWaiters]) {
      runtime.authorizationWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

export const controllerRelayService = new ControllerRelayService();
