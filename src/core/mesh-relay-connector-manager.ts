/**
 * Persistent lifecycle for the node's relay connection.
 *
 * The manager owns one active controller or worker relay connection, installs
 * its `MeshPeerTransport` for relay routes, and reconnects after network loss
 * with bounded exponential backoff and jitter. Retry policy lives here so a
 * one-shot pairing connection can never retry behind the caller's back.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import type { MeshRelayPeerRoute } from "@/shared/mesh";
import type {
  MeshRelayAuthOkFrame,
  MeshRelayPeerIdentity,
} from "@/shared/mesh-relay";
import { DomainError } from "../domain/domain-error";
import { setMeshRelayTransport } from "./mesh-peer-transport";
import type { MeshRelayClientSocketFactory } from "./mesh-relay-client-socket";
import {
  MeshRelayConnector,
  type MeshRelayConnectorConfig,
  type MeshRelayConnectorIdentity,
  type MeshRelayConnectorOptions,
  type MeshRelayConnectorStatus,
} from "./mesh-relay-connector";
import { createMeshRelayInboundHandler } from "./mesh-relay-inbound";
import { createMeshRelayPeerTransport } from "./mesh-relay-transport";

const log = createLogger("core:mesh-relay-connector-manager");

export const MESH_RELAY_RECONNECT_BASE_DELAY_MS = 1_000;
export const MESH_RELAY_RECONNECT_MAX_DELAY_MS = 30_000;

export interface MeshRelayConnectionRequest {
  config: MeshRelayConnectorConfig;
  /** In-process HTTP dispatcher used for inbound relayed requests. */
  dispatch(request: Request): Promise<Response | undefined>;
  onAuthenticated?(frame: MeshRelayAuthOkFrame): void;
  onStatusChange?(status: MeshRelayConnectorStatus): void;
  shouldMaintain?(): boolean | Promise<boolean>;
}

export interface MeshRelayConnectorManagerOptions {
  socketFactory?: MeshRelayClientSocketFactory;
  /** Explicit Mesh signing identity; defaults to the local node identity. */
  identity?: MeshRelayConnectorIdentity;
  /** Injection seam for deterministic lifecycle tests. */
  createConnector?(options: MeshRelayConnectorOptions): MeshRelayConnector;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Controllers with multiple relays install one shared route-aware transport. */
  manageTransport?: boolean;
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
  private request?: MeshRelayConnectionRequest;
  private connector?: MeshRelayConnector;
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private readonly waiters = new Set<ConnectedWaiter>();

  constructor(private readonly options: MeshRelayConnectorManagerOptions = {}) {}

  get status(): MeshRelayConnectorStatus {
    return this.connector?.status ?? "idle";
  }

  get authorization(): MeshRelayAuthOkFrame | undefined {
    return this.connector?.authorization;
  }

  get activeConfig(): MeshRelayConnectorConfig | undefined {
    return this.request?.config;
  }

  /** Begin maintaining the relay connection and install the relay transport. */
  start(request: MeshRelayConnectionRequest): void {
    if (this.running) {
      throw new DomainError(
        "mesh_relay_already_started",
        "A Mesh relay connection is already being maintained.",
      );
    }
    this.request = request;
    this.running = true;
    if (this.options.manageTransport !== false) {
      setMeshRelayTransport(createMeshRelayPeerTransport(
        (route) => this.resolveConnector(route),
      ));
    }
    this.loop = this.run();
  }

  /** Stop maintaining the connection and remove the relay transport. */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    if (this.options.manageTransport !== false) {
      setMeshRelayTransport(null);
    }
    this.connector?.close(1000, "Mesh relay connection stopped");
    this.interruptBackoff();
    const loop = this.loop;
    this.loop = undefined;
    await loop;
    this.rejectWaiters(new DomainError(
      "mesh_relay_disconnected",
      "The Mesh relay connection was stopped.",
    ));
    this.connector = undefined;
    this.request = undefined;
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
  async replaceAuthorization(workers: MeshRelayPeerIdentity[]): Promise<number> {
    const connector = this.connector;
    if (!connector || connector.status !== "connected") {
      throw new DomainError(
        "mesh_relay_disconnected",
        "The Mesh relay connection is not authenticated.",
      );
    }
    return await connector.replaceAuthorization(workers);
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
          log.error("The Mesh relay connection configuration became invalid", {
            relayUrl: request.config.relayUrl,
            error: String(error),
          });
        }
      }
      if (!shouldMaintain) {
        this.running = false;
        if (this.options.manageTransport !== false) {
          setMeshRelayTransport(null);
        }
        this.request = undefined;
        this.connector = undefined;
        this.rejectWaiters(new DomainError(
          "mesh_relay_disconnected",
          "The Mesh relay connection is no longer configured.",
        ));
        return;
      }
      const inbound = createMeshRelayInboundHandler({
        role: request.config.role,
        dispatch: request.dispatch,
      });
      let resolveClosed: () => void = () => {};
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const create = this.options.createConnector
        ?? ((options: MeshRelayConnectorOptions) => new MeshRelayConnector(options));
      const connector = create({
        config: request.config,
        inbound,
        ...(this.options.identity ? { identity: this.options.identity } : {}),
        ...(this.options.socketFactory
          ? { socketFactory: this.options.socketFactory }
          : {}),
        onStatusChange: (status) => request.onStatusChange?.(status),
        onAuthenticated: (frame) => {
          this.resolveWaiters(frame);
          request.onAuthenticated?.(frame);
        },
        onClosed: () => resolveClosed(),
      });
      this.connector = connector;
      try {
        await connector.connect();
        attempt = 0;
        await closed;
      } catch (error) {
        if (this.running) {
          log.warn("The Mesh relay connection attempt failed", {
            relayUrl: request.config.relayUrl,
            attempt: attempt + 1,
            error: String(error),
          });
        }
      } finally {
        connector.close(1000, "Mesh relay connection replaced");
        resolveClosed();
      }
      if (!this.running) {
        return;
      }
      attempt += 1;
      await this.backoff(backoffDelay(
        attempt,
        this.options.baseDelayMs ?? MESH_RELAY_RECONNECT_BASE_DELAY_MS,
        this.options.maxDelayMs ?? MESH_RELAY_RECONNECT_MAX_DELAY_MS,
      ));
    }
  }

  private async backoff(delayMs: number): Promise<void> {
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
