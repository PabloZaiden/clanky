/**
 * Portable outbound relay connection lifecycle.
 *
 * The manager owns one active relay connection and reconnects after network loss
 * with bounded exponential backoff and jitter. Retry policy lives here so a
 * one-shot pairing connection can never retry behind the caller's back.
 */

import type { MeshRelayPeerRoute } from "@/shared/mesh";
import type { MeshProtocolVersion } from "@/shared/mesh-protocol";
import type {
  MeshRelayAuthOkFrame,
  MeshRelayPeerIdentity,
} from "@/shared/mesh-relay";
import { DomainError } from "../../domain/domain-error";
import type { MeshRelayClientSocketFactory } from "../../core/mesh-relay-client-socket";
import {
  MeshRelayConnector,
  MESH_RELAY_MAX_PENDING_REQUESTS,
  type MeshRelayConnectorConfig,
  type MeshRelayInboundHandler,
  type MeshRelayConnectorOptions,
  type MeshRelayConnectorStatus,
} from "../../core/mesh-relay-connector";
import type { CollaborationClientLogger } from "./types";

export const MESH_RELAY_RECONNECT_BASE_DELAY_MS = 1_000;
export const MESH_RELAY_RECONNECT_MAX_DELAY_MS = 30_000;

export interface MeshRelayConnectionRequest {
  config: MeshRelayConnectorConfig;
  inbound?: MeshRelayInboundHandler;
  onAuthenticated?(frame: MeshRelayAuthOkFrame): void;
  onStatusChange?(status: MeshRelayConnectorStatus): void;
  shouldMaintain?(): boolean | Promise<boolean>;
  refreshProtocol?(): Promise<MeshProtocolVersion>;
  onStopped?(): void;
}

export interface MeshRelayConnectorManagerOptions {
  socketFactory?: MeshRelayClientSocketFactory;
  identity: MeshRelayConnectorOptions["identity"];
  logger?: CollaborationClientLogger;
  /** Host-specific connector adaptation, without importing host services. */
  createConnector?(options: MeshRelayConnectorOptions): MeshRelayConnector;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

interface ConnectedWaiter {
  resolve(frame: MeshRelayAuthOkFrame): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = exponential * 0.25;
  return Math.round(exponential - jitter + Math.random() * jitter * 2);
}

export class MeshRelayConnectorManager {
  private readonly log: CollaborationClientLogger;
  private request?: MeshRelayConnectionRequest;
  private connector?: MeshRelayConnector;
  private running = false;
  private loop?: Promise<void>;
  private stopping?: Promise<void>;
  private wake?: () => void;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private readonly waiters = new Set<ConnectedWaiter>();

  constructor(private readonly options: MeshRelayConnectorManagerOptions) {
    this.log = options.logger ?? console;
  }

  get status(): MeshRelayConnectorStatus {
    return this.connector?.status ?? "idle";
  }

  get authorization(): MeshRelayAuthOkFrame | undefined {
    return this.connector?.authorization;
  }

  get activeConfig(): MeshRelayConnectorConfig | undefined {
    return this.request?.config;
  }

  /** Begin maintaining exactly one connection. Stop before replacing it. */
  start(request: MeshRelayConnectionRequest): void {
    if (this.running || this.loop || this.stopping) {
      throw new DomainError(
        "mesh_relay_already_started",
        "A Mesh relay connection is already being maintained.",
      );
    }
    this.request = request;
    this.running = true;
    this.loop = this.run();
  }

  /** Stop maintenance and await the old lifecycle before a replacement starts. */
  async stop(): Promise<void> {
    if (this.stopping) return await this.stopping;
    const operation = this.stopRuntime();
    this.stopping = operation;
    try {
      await operation;
    } finally {
      if (this.stopping === operation) this.stopping = undefined;
    }
  }

  private async stopRuntime(): Promise<void> {
    if (!this.running && !this.loop) {
      return;
    }
    this.running = false;
    const request = this.request;
    this.connector?.close(1000, "Mesh relay connection stopped");
    this.interruptBackoff();
    const loop = this.loop;
    await loop;
    await this.connector?.waitUntilTransportClosed();
    this.loop = undefined;
    this.rejectWaiters(new DomainError(
      "mesh_relay_disconnected",
      "The Mesh relay connection was stopped.",
    ));
    this.connector = undefined;
    this.request = undefined;
    request?.onStopped?.();
  }

  /** Resolve once the relay connection is authenticated. */
  async waitUntilConnected(timeoutMs = 30_000): Promise<MeshRelayAuthOkFrame> {
    const authorization = this.connector?.authorization;
    if (this.connector?.status === "connected" && authorization) {
      return authorization;
    }
    if (!this.running) {
      throw new DomainError(
        "mesh_relay_disconnected",
        "No Mesh relay connection is being maintained.",
      );
    }
    if (this.waiters.size >= MESH_RELAY_MAX_PENDING_REQUESTS) {
      throw new DomainError(
        "mesh_relay_connection_capacity",
        "Too many requests are waiting for the Mesh relay connection.",
      );
    }
    return await new Promise<MeshRelayAuthOkFrame>((resolve, reject) => {
      const waiter: ConnectedWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new DomainError(
            "mesh_relay_connect_timeout",
            "The Mesh relay connection did not become ready in time.",
          ));
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      this.waiters.add(waiter);
    });
  }

  /** Replace the relay's authorized worker snapshot on the live connection. */
  async replaceAuthorization(
    workers: MeshRelayPeerIdentity[],
    clients?: MeshRelayPeerIdentity[],
  ): Promise<number> {
    const connector = this.connector;
    if (!connector || connector.status !== "connected") {
      throw new DomainError(
        "mesh_relay_disconnected",
        "The Mesh relay connection is not authenticated.",
      );
    }
    return await connector.replaceAuthorization(workers, clients);
  }

  /**
   * Close the current one-shot connector. If maintenance is still running,
   * the normal bounded backoff loop establishes a fresh connection.
   */
  closeCurrentConnection(
    code = 1011,
    reason = "Mesh relay connection refresh requested",
  ): void {
    if (!this.running) {
      return;
    }
    const connector = this.connector;
    if (connector && connector.status !== "closed") {
      connector.close(code, reason);
      return;
    }
    this.interruptBackoff();
  }

  resolveConnector(route: MeshRelayPeerRoute): MeshRelayConnector {
    const connector = this.connector;
    const config = this.request?.config;
    if (!connector || !config || connector.status !== "connected") {
      throw new DomainError(
        "mesh_relay_unavailable",
        "The Mesh relay transport is not connected.",
      );
    }
    if (
      route.relayUrl !== config.relayUrl
      || route.relayFingerprint !== config.relayFingerprint
    ) {
      throw new DomainError(
        "mesh_relay_route_mismatch",
        "The Mesh route does not match the active relay connection.",
      );
    }
    return connector;
  }

  private async run(): Promise<void> {
    let attempt = 0;
    while (this.running) {
      const request = this.request;
      if (!request) {
        return;
      }
      let shouldMaintain = true;
      if (request.shouldMaintain) {
        try {
          shouldMaintain = await request.shouldMaintain();
        } catch (error) {
          shouldMaintain = false;
          this.log.error("The Mesh relay connection configuration became invalid", {
            relayUrl: request.config.relayUrl,
            error: String(error),
          });
        }
        if (!this.running || this.request !== request) return;
      }
      if (!shouldMaintain) {
        this.running = false;
        request.onStopped?.();
        this.request = undefined;
        this.connector = undefined;
        this.rejectWaiters(new DomainError(
          "mesh_relay_disconnected",
          "The Mesh relay connection is no longer configured.",
        ));
        return;
      }
      let resolveClosed: () => void = () => {};
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const create = this.options.createConnector
        ?? ((options: MeshRelayConnectorOptions) => new MeshRelayConnector(options));
      let connector: MeshRelayConnector | undefined;
      try {
        if (request.refreshProtocol) {
          request.config = { ...request.config, protocolVersion: await request.refreshProtocol() };
        }
        if (!this.running) return;
        connector = create({
          config: request.config,
          inbound: request.inbound,
          identity: this.options.identity,
          logger: this.log,
          ...(this.options.socketFactory ? { socketFactory: this.options.socketFactory } : {}),
          onStatusChange: (status) => {
            if (this.request === request && this.connector === connector) request.onStatusChange?.(status);
          },
          onAuthenticated: (frame) => {
            if (!this.running || this.request !== request || this.connector !== connector) return;
            this.resolveWaiters(frame);
            request.onAuthenticated?.(frame);
          },
          onClosed: () => resolveClosed(),
        });
        this.connector = connector;
        await connector.connect();
        attempt = 0;
        await closed;
      } catch (error) {
        if (this.running) {
          this.log.warn("The Mesh relay connection attempt failed", {
            relayUrl: request.config.relayUrl,
            attempt: attempt + 1,
            error: String(error),
          });
        }
      } finally {
        connector?.close(1000, "Mesh relay connection replaced");
        while (connector) {
          try {
            await connector.waitUntilTransportClosed();
            break;
          } catch (error) {
            this.log.warn("The Mesh relay transport could not finish closing", {
              relayUrl: request.config.relayUrl,
              retrying: this.running,
              error: String(error),
            });
            if (!this.running) {
              this.rejectWaiters(error);
              break;
            }
            attempt += 1;
            await this.backoff(attempt);
            if (!this.running) break;
          }
        }
        resolveClosed();
      }
      if (!this.running) {
        return;
      }
      attempt += 1;
      await this.backoff(attempt);
    }
  }

  private async backoff(attempt: number): Promise<void> {
    const delayMs = backoffDelay(
      attempt,
      this.options.baseDelayMs ?? MESH_RELAY_RECONNECT_BASE_DELAY_MS,
      this.options.maxDelayMs ?? MESH_RELAY_RECONNECT_MAX_DELAY_MS,
    );
    await new Promise<void>((resolve) => {
      this.wake = resolve;
      this.wakeTimer = setTimeout(() => {
        this.wake = undefined;
        this.wakeTimer = undefined;
        resolve();
      }, delayMs);
      this.wakeTimer.unref?.();
    });
  }

  private interruptBackoff(): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private resolveWaiters(frame: MeshRelayAuthOkFrame): void {
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
  }

  private rejectWaiters(error: unknown): void {
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}
