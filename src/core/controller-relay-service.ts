/**
 * Controller-owned relay pairing and persistent connection lifecycle.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import {
  MeshRelayWellKnownDescriptorSchema,
} from "@/contracts/schemas/mesh-relay";
import {
  MESH_RELAY_DESCRIPTOR_PATH,
  normalizeMeshRelayOrigin,
  type MeshRelayPeerIdentity,
  type MeshRelayWellKnownDescriptor,
  type MeshRelayWellKnownDescriptorV5,
} from "@/shared/mesh-relay";
import { MESH_PROTOCOL_VERSIONS_HEADER, serializeMeshProtocolVersions } from "@/shared/mesh-protocol";
import {
  MESH_LEGACY_PROTOCOL_VERSION,
  MESH_PROTOCOL_VERSION,
  type MeshProtocolVersion,
} from "@/shared/mesh-protocol";
import type { MeshEnrollmentRoute } from "@/contracts/schemas/mesh";
import {
  deleteControllerRelayPairing,
  getControllerRelayPairing,
  InconsistentMeshWorkerIdentityError,
  listActiveControllerWorkerIdentities,
  restoreControllerRelayPairing,
  saveControllerRelayPairing,
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
import { requireMeshRuntimeRole } from "./mesh-runtime";

const log = createLogger("core:controller-relay-service");

export const CONTROLLER_RELAY_DESCRIPTOR_TIMEOUT_MS = 10_000;
export const CONTROLLER_RELAY_DESCRIPTOR_MAX_BYTES = 64 * 1024;
export const CONTROLLER_RELAY_CONNECTION_TIMEOUT_MS = 30_000;
export const RELAY_CONTROLLER_FINGERPRINT_ENV =
  "CLANKY_RELAY_CONTROLLER_FINGERPRINT";

export interface ControllerRelayStatus {
  paired: boolean;
  relayUrl: string | null;
  relayFingerprint: string | null;
  controllerFingerprint: string;
  connected: boolean;
  runtimeError: {
    code: string;
    message: string;
  } | null;
  pairedAt: string | null;
  updatedAt: string | null;
  bootstrapEnvironment: string;
  relayBinaryVersion: string | null;
  relaySupportedProtocolVersions: MeshProtocolVersion[];
  relayPreferredProtocolVersion: MeshProtocolVersion;
  relayNegotiatedProtocolVersion: MeshProtocolVersion | null;
}

export interface MeshEnrollmentInvitationTarget {
  route: MeshEnrollmentRoute;
  target: string;
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
  pairing: ControllerRelayPairing | null,
  controllerFingerprint: string,
  connected: boolean,
  runtimeError: ControllerRelayStatus["runtimeError"],
): ControllerRelayStatus {
  return {
    paired: pairing !== null,
    relayUrl: pairing?.relayUrl ?? null,
    relayFingerprint: pairing?.relayFingerprint ?? null,
    controllerFingerprint,
    connected,
    runtimeError,
    pairedAt: pairing?.pairedAt ?? null,
    updatedAt: pairing?.updatedAt ?? null,
    bootstrapEnvironment:
      `${RELAY_CONTROLLER_FINGERPRINT_ENV}=${controllerFingerprint}`,
    relayBinaryVersion: pairing?.relayBinaryVersion ?? null,
    relaySupportedProtocolVersions: pairing?.relaySupportedProtocolVersions
      ?? [MESH_LEGACY_PROTOCOL_VERSION],
    relayPreferredProtocolVersion: pairing?.relayPreferredProtocolVersion
      ?? MESH_LEGACY_PROTOCOL_VERSION,
    relayNegotiatedProtocolVersion: pairing?.relayNegotiatedProtocolVersion
      ?? null,
  };
}

export class ControllerRelayService {
  private readonly manager: MeshRelayConnectorManager;
  private dispatch?: RelayDispatch;
  private unsubscribeMesh?: () => void;
  private lifecycle = Promise.resolve();
  private authorizationDirty = false;
  private authorizationRefresh?: Promise<void>;
  private readonly authorizationWaiters = new Set<AuthorizationWaiter>();
  private runtimeError: ControllerRelayStatus["runtimeError"] = null;
  private onAuthenticated?: () => void;

  constructor(private readonly options: ControllerRelayServiceOptions = {}) {
    this.manager = options.manager ?? new MeshRelayConnectorManager();
  }

  async getStatus(): Promise<ControllerRelayStatus> {
    requireMeshRuntimeRole("controller");
    const identity = await ensureLocalMeshNodeIdentity();
    return pairingStatus(
      getControllerRelayPairing(),
      identity.fingerprint,
      this.manager.status === "connected",
      this.runtimeError,
    );
  }

  async resolveEnrollmentInvitationTarget(
    route: MeshEnrollmentRoute,
    directTarget: string,
  ): Promise<MeshEnrollmentInvitationTarget> {
    requireMeshRuntimeRole("controller");
    if (route === "direct") {
      return { route, target: directTarget };
    }
    const pairing = getControllerRelayPairing();
    if (!pairing) {
      throw new DomainError(
        "mesh_relay_not_paired",
        "Pair a controller relay before creating a relay enrollment invitation.",
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
    return { route, target: pairing.relayUrl };
  }

  getDedicatedWorkerEnrollmentRoute(): MeshEnrollmentRoute {
    requireMeshRuntimeRole("controller");
    return getControllerRelayPairing() ? "relay" : "direct";
  }

  assertEnrollmentRelayRoute(route: {
    relayUrl: string;
    relayFingerprint: string;
  }): ControllerRelayPairing {
    requireMeshRuntimeRole("controller");
    const pairing = getControllerRelayPairing();
    if (
      !pairing
      || pairing.relayUrl !== route.relayUrl
      || pairing.relayFingerprint !== route.relayFingerprint
    ) {
      throw new DomainError(
        "mesh_enrollment_relay_mismatch",
        "The enrollment relay route does not match the controller's active pairing.",
      );
    }
    return pairing;
  }

  async pair(relayUrl: string): Promise<ControllerRelayStatus> {
    return await this.runLifecycle(async () => {
      requireMeshRuntimeRole("controller");
      const normalizedRelayUrl = this.normalizeRelayUrl(relayUrl);
      const identity = await ensureLocalMeshNodeIdentity();
      const descriptor = await this.fetchDescriptor(normalizedRelayUrl);
      if (descriptor.controllerFingerprint !== identity.fingerprint) {
        throw new DomainError(
          "mesh_relay_controller_mismatch",
          "The relay is configured for a different controller fingerprint.",
        );
      }

      const connectorFactory = this.options.createConnector
        ?? ((options: MeshRelayConnectorOptions) => new MeshRelayConnector(options));
      const connector = connectorFactory({
        config: {
          relayUrl: normalizedRelayUrl,
          relayFingerprint: descriptor.fingerprint,
          role: "controller",
          ...("protocolVersion" in descriptor
            && descriptor.protocolVersion === MESH_PROTOCOL_VERSION
            ? { protocolVersion: MESH_PROTOCOL_VERSION }
            : {}),
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

      const previousPairing = getControllerRelayPairing();
      const pairing = saveControllerRelayPairing({
        relayUrl: normalizedRelayUrl,
        relayPublicKey: descriptor.publicKey,
        relayFingerprint: descriptor.fingerprint,
        controllerNodeId: identity.nodeId,
        controllerFingerprint: identity.fingerprint,
        relayBinaryVersion: "protocolVersion" in descriptor
          && descriptor.protocolVersion === MESH_PROTOCOL_VERSION
          ? descriptor.binaryVersion
          : null,
        relaySupportedProtocolVersions: "protocolVersion" in descriptor
          && descriptor.protocolVersion === MESH_PROTOCOL_VERSION
          ? descriptor.supportedProtocolVersions
          : [MESH_LEGACY_PROTOCOL_VERSION],
        relayPreferredProtocolVersion: "protocolVersion" in descriptor
          && descriptor.protocolVersion === MESH_PROTOCOL_VERSION
          ? descriptor.preferredProtocolVersion
          : MESH_LEGACY_PROTOCOL_VERSION,
        relayNegotiatedProtocolVersion: "protocolVersion" in descriptor
          && descriptor.protocolVersion === MESH_PROTOCOL_VERSION
          ? descriptor.negotiatedProtocolVersion
          : MESH_LEGACY_PROTOCOL_VERSION,
      });
      this.runtimeError = null;
      if (this.dispatch) {
        try {
          await this.restartManager(pairing, true);
        } catch (error) {
          await this.stopManager();
          if (previousPairing) {
            restoreControllerRelayPairing(previousPairing);
            try {
              await this.restartManager(previousPairing, false);
            } catch (restoreError) {
              this.setRuntimeError(restoreError);
              log.error("Previous controller relay runtime could not be restored", {
                error: String(restoreError),
              });
            }
          } else {
            deleteControllerRelayPairing();
            this.runtimeError = null;
          }
          throw error;
        }
      }
      return pairingStatus(
        pairing,
        identity.fingerprint,
        this.manager.status === "connected",
        this.runtimeError,
      );
    });
  }

  async unpair(): Promise<ControllerRelayStatus> {
    return await this.runLifecycle(async () => {
      requireMeshRuntimeRole("controller");
      await this.stopManager();
      deleteControllerRelayPairing();
      this.runtimeError = null;
      const identity = await ensureLocalMeshNodeIdentity();
      return pairingStatus(null, identity.fingerprint, false, null);
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
      const pairing = getControllerRelayPairing();
      if (pairing) {
        try {
          await this.restartManager(pairing, false);
        } catch (error) {
          await this.stopManager();
          this.setRuntimeError(error);
          log.error("Controller relay runtime could not be started", {
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
      await this.stopManager();
      this.dispatch = undefined;
      this.onAuthenticated = undefined;
      this.runtimeError = null;
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

  private async fetchDescriptor(
    relayUrl: string,
  ): Promise<MeshRelayWellKnownDescriptor | MeshRelayWellKnownDescriptorV5> {
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
    let descriptor: MeshRelayWellKnownDescriptor | MeshRelayWellKnownDescriptorV5;
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
    const metadata = "protocolVersion" in descriptor
      && descriptor.protocolVersion === MESH_PROTOCOL_VERSION
      ? {
          relayBinaryVersion: descriptor.binaryVersion,
          relaySupportedProtocolVersions: descriptor.supportedProtocolVersions,
          relayPreferredProtocolVersion: descriptor.preferredProtocolVersion,
          relayNegotiatedProtocolVersion: descriptor.negotiatedProtocolVersion,
        }
      : {
          relayBinaryVersion: null,
          relaySupportedProtocolVersions: [
            MESH_LEGACY_PROTOCOL_VERSION,
          ] as MeshProtocolVersion[],
          relayPreferredProtocolVersion: MESH_LEGACY_PROTOCOL_VERSION,
          relayNegotiatedProtocolVersion: MESH_LEGACY_PROTOCOL_VERSION,
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
      relayUrl: pairing.relayUrl,
      relayPublicKey: pairing.relayPublicKey,
      relayFingerprint: pairing.relayFingerprint,
      controllerNodeId: pairing.controllerNodeId,
      controllerFingerprint: pairing.controllerFingerprint,
      ...metadata,
    });
  }

  private async restartManager(
    pairing: ControllerRelayPairing,
    waitForConnection: boolean,
  ): Promise<void> {
    await this.stopManager();
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
    this.runtimeError = null;
    this.authorizationDirty = true;
    this.manager.start({
      config: {
        relayUrl,
        relayFingerprint: pairing.relayFingerprint,
        role: "controller",
        ...(pairing.relayNegotiatedProtocolVersion === MESH_PROTOCOL_VERSION
          ? { protocolVersion: MESH_PROTOCOL_VERSION }
          : {}),
      },
      dispatch,
      onAuthenticated: () => {
        this.authorizationDirty = true;
        this.requestAuthorizationRefresh();
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
      await this.manager.waitUntilConnected(CONTROLLER_RELAY_CONNECTION_TIMEOUT_MS);
      this.requestAuthorizationRefresh();
      await this.waitUntilAuthorizationSynchronized(
        CONTROLLER_RELAY_CONNECTION_TIMEOUT_MS,
      );
    }
  }

  private requestAuthorizationRefresh(): void {
    this.authorizationDirty = true;
    if (
      this.authorizationRefresh
      || this.manager.status !== "connected"
    ) {
      return;
    }
    this.authorizationRefresh = this.refreshAuthorization()
      .finally(() => {
        this.authorizationRefresh = undefined;
        if (this.authorizationDirty && this.manager.status === "connected") {
          this.requestAuthorizationRefresh();
        } else if (
          !this.authorizationDirty
          && this.manager.status === "connected"
        ) {
          this.resolveAuthorizationWaiters();
        }
      });
  }

  private requestRuntimeRefresh(): void {
    void this.runLifecycle(async () => {
      if (!this.dispatch) {
        return;
      }
      if (this.manager.activeConfig) {
        this.requestAuthorizationRefresh();
        return;
      }
      const pairing = getControllerRelayPairing();
      if (!pairing) {
        this.runtimeError = null;
        return;
      }
      try {
        await this.restartManager(pairing, false);
      } catch (error) {
        await this.stopManager();
        this.setRuntimeError(error);
        log.error("Controller relay runtime could not be refreshed", {
          error: String(error),
        });
      }
    }).catch((error: unknown) => {
      this.setRuntimeError(error);
      log.error("Controller relay runtime refresh failed", {
        error: String(error),
      });
    });
  }

  private async refreshAuthorization(): Promise<void> {
    while (this.authorizationDirty && this.manager.status === "connected") {
      this.authorizationDirty = false;
      let workers: MeshRelayPeerIdentity[];
      try {
        const config = this.manager.activeConfig;
        if (!config) {
          return;
        }
        workers = this.loadAuthorizationWorkers({
          relayUrl: config.relayUrl,
          relayFingerprint: config.relayFingerprint,
        });
      } catch (error) {
        const mapped = this.mapRuntimeError(error);
        this.runtimeError = {
          code: mapped.code,
          message: mapped.message,
        };
        this.rejectAuthorizationWaiters(mapped);
        log.error("Controller relay authorization snapshot is invalid", {
          error: String(mapped),
        });
        return;
      }
      try {
        await this.manager.replaceAuthorization(workers);
        this.runtimeError = null;
      } catch (error) {
        if (
          error instanceof MeshRelayStreamError
          && error.status >= 400
          && error.status < 500
        ) {
          const mapped = this.mapRuntimeError(error);
          this.runtimeError = {
            code: mapped.code,
            message: mapped.message,
          };
          this.rejectAuthorizationWaiters(mapped);
          log.error("Controller relay rejected the authorization snapshot", {
            error: String(mapped),
          });
          return;
        }
        this.authorizationDirty = true;
        log.warn("Controller relay authorization refresh was ambiguous", {
          error: String(error),
        });
        this.manager.closeCurrentConnection(
          1011,
          "Relay authorization synchronization failed",
        );
        return;
      }
    }
  }

  private async stopManager(): Promise<void> {
    await this.manager.stop();
    await this.authorizationRefresh;
    this.authorizationRefresh = undefined;
    this.authorizationDirty = false;
    this.rejectAuthorizationWaiters(new DomainError(
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

  private setRuntimeError(error: unknown): void {
    const mapped = this.mapRuntimeError(error);
    this.runtimeError = {
      code: mapped.code,
      message: mapped.message,
    };
  }

  private async waitUntilAuthorizationSynchronized(
    timeoutMs: number,
  ): Promise<void> {
    if (
      this.manager.status === "connected"
      && !this.authorizationDirty
      && !this.authorizationRefresh
    ) {
      return;
    }
    return await new Promise<void>((resolve, reject) => {
      const waiter: AuthorizationWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.authorizationWaiters.delete(waiter);
          reject(new DomainError(
            "mesh_relay_authorization_failed",
            "The relay worker authorization snapshot could not be synchronized.",
          ));
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      this.authorizationWaiters.add(waiter);
    });
  }

  private resolveAuthorizationWaiters(): void {
    for (const waiter of [...this.authorizationWaiters]) {
      this.authorizationWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private rejectAuthorizationWaiters(error: unknown): void {
    for (const waiter of [...this.authorizationWaiters]) {
      this.authorizationWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

export const controllerRelayService = new ControllerRelayService();
