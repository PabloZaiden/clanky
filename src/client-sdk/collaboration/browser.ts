/**
 * Browser profile/session composition over the actual shared invited client.
 */

import type {
  WebAppExternalClient, WebAppExternalSession, WebAppDuplex, RealtimeSource,
  WebAppResourceUrl, WebAppSaveResourceOptions,
} from "@pablozaiden/webapp/web";
import type { CollaborationConnection, WorkspaceConnectionStatus } from "@/shared/collaboration";
import type { CollaborationRouteOperation } from "@/shared/collaboration-operation";
import { DomainError } from "../../domain/domain-error";
import { BrowserCollaborationPairingStore } from "./browser-store";
import { BrowserCollaborationOwnership } from "./browser-ownership";
import { BrowserCollaborationRealtime } from "./browser-realtime";
import { BrowserCollaborationDuplex } from "./browser-duplex";
import { BrowserCollaborationDownloads } from "./browser-downloads";
import { BrowserCollaborationResources } from "./browser-resources";
import { CollaborationClientEngine } from "./engine";
import { CollaborationFederationClient } from "./federation";
import { collaborationTerminalOperation } from "./socket";
import { loadCollaborationOperations } from "./catalog";
import type { CollaborationClientLogger } from "./types";

export interface BrowserConnectionSnapshot {
  readonly connections: readonly WorkspaceConnectionStatus[];
  readonly loading: boolean;
  readonly error: Error | null;
}

const MAX_PROFILE_OBSERVERS = 256;

export class BrowserCollaborationClient implements WebAppExternalClient {
  private readonly engine: CollaborationClientEngine;
  private readonly realtime: BrowserCollaborationRealtime;
  private readonly federation: CollaborationFederationClient;
  private readonly resources: BrowserCollaborationResources;
  readonly downloads: BrowserCollaborationDownloads;
  private readonly sessionListeners = new Set<() => void>();
  private readonly connectionListeners = new Set<() => void>();
  private readonly channels = new Map<symbol, BrowserCollaborationDuplex>();
  private readonly lifetime = new AbortController();
  private snapshot: WebAppExternalSession;
  private connectionSnapshot: BrowserConnectionSnapshot = { connections: [], loading: true, error: null };
  private refreshing?: Promise<void>;
  private refreshDirty = false;
  private disposed = false;
  private stopping?: Promise<void>;

  readonly session = {
    getSnapshot: (): WebAppExternalSession => this.snapshot,
    subscribe: (listener: () => void): (() => void) => this.observe(this.sessionListeners, listener),
    refresh: async (): Promise<void> => { this.assertOpen(); await this.refreshConnections(); },
  };

  readonly connections = {
    getSnapshot: (): BrowserConnectionSnapshot => this.connectionSnapshot,
    subscribe: (listener: () => void): (() => void) => this.observe(this.connectionListeners, listener),
  };

  private constructor(
    private readonly store: BrowserCollaborationPairingStore,
    operations: readonly CollaborationRouteOperation[],
    private readonly log: CollaborationClientLogger,
  ) {
    this.snapshot = { scope: store.scope, generation: 0, ready: true, logLevel: "info" };
    this.engine = new CollaborationClientEngine({
      store, ownership: new BrowserCollaborationOwnership(store.scope), logger: log,
      changed: () => {
        // Engine changes also arrive outside explicit UI operations.
        void this.refreshConnections().catch((error: unknown) => {
          this.log.error("Browser pairing state could not refresh", { error: String(error) });
        });
      },
      runtimeChanged: (runtime) => this.realtime.update(runtime),
      runtimeStopped: (id) => this.realtime.remove(id),
    });
    this.realtime = new BrowserCollaborationRealtime(this.engine, log);
    this.federation = new CollaborationFederationClient({
      operations, connections: this.engine, logger: log, representationScope: store.scope,
    });
    const resourceRequest = async (path: string, signal: AbortSignal): Promise<Response> => {
      const url = new URL(path, "https://client.invalid");
      if (!path.startsWith("/api/") || url.origin !== "https://client.invalid" || url.hash) {
        throw new DomainError("collaboration_operation_forbidden", "A logical shared API resource path is required.");
      }
      return await this.request(new Request(url, { signal }));
    };
    this.resources = new BrowserCollaborationResources(resourceRequest);
    this.downloads = new BrowserCollaborationDownloads({ scope: store.scope, request: resourceRequest, logger: log });
  }

  static async open(options: {
    catalogUrl: string | URL;
    databaseName?: string;
    logger?: CollaborationClientLogger;
    signal?: AbortSignal;
  }): Promise<BrowserCollaborationClient> {
    const log = options.logger ?? console;
    const operations = await loadCollaborationOperations(options.catalogUrl, options.signal);
    let client: BrowserCollaborationClient | undefined;
    let unavailable: DomainError | undefined;
    const store = await BrowserCollaborationPairingStore.open({
      databaseName: options.databaseName ?? "clanky-invited-client",
      onUnavailable: (error) => { unavailable = error; client?.storageUnavailable(error); },
    });
    try {
      options.signal?.throwIfAborted();
      if (unavailable) throw unavailable;
      client = new BrowserCollaborationClient(store, operations, log);
      await client.start(options.signal);
      return client;
    } catch (error) {
      try {
        await client?.stop();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "The browser client failed to start and close its transports.");
      } finally {
        store.close();
      }
      throw error;
    }
  }

  private async start(signal?: AbortSignal): Promise<void> {
    for (const connection of await this.store.list()) {
      this.assertOpen();
      signal?.throwIfAborted();
      if (connection.status !== "active") continue;
      try {
        await this.engine.open(connection.id, { waitForConnection: false });
      } catch (error) {
        this.log.warn("A stored browser pairing could not start", { error: String(error) });
      }
    }
    signal?.throwIfAborted();
    await this.refreshConnections();
  }

  async accept(input: { invitation: string; name?: string; guestName: string }): Promise<CollaborationConnection> {
    this.assertOpen();
    return await this.mutatePairing(async () => await this.engine.accept(input));
  }

  async recover(connectionId: string, guestName: string): Promise<CollaborationConnection> {
    this.assertOpen();
    return await this.mutatePairing(async () => await this.engine.recover(connectionId, guestName));
  }

  async forget(connectionId: string): Promise<void> {
    this.assertOpen();
    await this.mutatePairing(async () => await this.engine.forget(connectionId));
  }

  private async mutatePairing<T>(invoke: () => Promise<T>): Promise<T> {
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await invoke() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    try {
      await this.refreshConnections();
    } catch (error) {
      if (!outcome.ok) throw new AggregateError([outcome.error, error], "Pairing and browser state refresh both failed.");
      throw error;
    } finally {
      this.realtime.refresh();
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  async request(request: Request): Promise<Response> {
    this.assertOpen();
    return await this.federation.request(new Request(request, {
      signal: AbortSignal.any([request.signal, this.lifetime.signal]),
    }));
  }

  createRealtimeSource(): RealtimeSource {
    this.assertOpen();
    return this.realtime.createSource();
  }

  async resourceUrl(path: string, options: { signal?: AbortSignal } = {}): Promise<WebAppResourceUrl> {
    this.assertOpen();
    return await this.resources.url(path, options);
  }

  async saveResource(path: string, options: WebAppSaveResourceOptions): Promise<void> {
    this.assertOpen();
    await this.downloads.save(path, options);
  }

  resynchronize(): void {
    this.assertOpen();
    this.realtime.resynchronize();
  }

  async connect(path: string, options: { signal?: AbortSignal }): Promise<WebAppDuplex> {
    this.assertOpen();
    options.signal?.throwIfAborted();
    const url = new URL(path, "https://client.invalid");
    if (url.origin !== "https://client.invalid" || url.pathname !== "/api/terminal"
      || url.hash || [...url.searchParams.keys()].some((key) => key !== "terminalSessionId")
      || url.searchParams.getAll("terminalSessionId").length !== 1) {
      throw new DomainError("collaboration_operation_forbidden", "Only an app-owned shared terminal is available in this browser.");
    }
    const target = collaborationTerminalOperation(url.searchParams.get("terminalSessionId")!);
    if (!target) throw new DomainError("collaboration_authority_required", "Select a terminal in a shared workspace.");
    if (this.channels.size >= 64) throw new DomainError("collaboration_connection_capacity", "Too many open browser terminals.");
    const token = Symbol("terminal");
    const channel = new BrowserCollaborationDuplex({
      runtime: this.engine.require(target.connectionId), operation: target.operation, logger: this.log,
      signal: AbortSignal.any([this.lifetime.signal, ...(options.signal ? [options.signal] : [])]),
      closed: () => this.channels.delete(token),
    });
    this.channels.set(token, channel);
    return channel;
  }

  private async refreshConnections(): Promise<void> {
    if (this.disposed) return;
    this.refreshDirty = true;
    if (this.refreshing) return await this.refreshing;
    const pending = this.readConnections().finally(() => {
      if (this.refreshing === pending) this.refreshing = undefined;
    });
    this.refreshing = pending;
    await pending;
  }

  private async readConnections(): Promise<void> {
    while (this.refreshDirty && !this.disposed) {
      this.refreshDirty = false;
      try {
        const connections = await this.engine.list();
        if (this.disposed) return;
        this.connectionSnapshot = { connections, loading: false, error: null };
      } catch (error) {
        if (this.disposed) return;
        this.connectionSnapshot = {
          ...this.connectionSnapshot, loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        };
        this.emit(this.connectionListeners);
        throw error;
      }
      this.emit(this.connectionListeners);
    }
  }

  private observe(listeners: Set<() => void>, listener: () => void): () => void {
    this.assertOpen();
    if (listeners.size >= MAX_PROFILE_OBSERVERS) throw new DomainError("collaboration_connection_capacity", "Too many browser profile observers.");
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  private emit(listeners: ReadonlySet<() => void>): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        this.log.error("Browser profile observer failed", { error: String(error) });
      }
    }
  }

  private storageUnavailable(error: DomainError): void {
    this.snapshot = { ...this.snapshot, generation: this.snapshot.generation + 1, ready: false, error };
    this.emit(this.sessionListeners);
    void this.stop().catch((failure: unknown) => this.log.error("Browser storage loss cleanup failed", { error: String(failure) }));
  }

  private assertOpen(): void {
    if (this.disposed) throw new DomainError("collaboration_disconnected", "The browser collaboration client is closed.");
  }

  async stop(): Promise<void> {
    if (this.stopping) return await this.stopping;
    this.disposed = true;
    this.lifetime.abort();
    const stopping = this.stopOwnedResources();
    this.stopping = stopping;
    await stopping;
  }

  private async stopOwnedResources(): Promise<void> {
    const results = await Promise.allSettled([
      this.realtime.stop(), this.engine.stop(),
      this.resources.stop(), this.downloads.stop(),
      ...[...this.channels.values()].map(async (channel) => await channel.close()),
      ...(this.refreshing ? [this.refreshing] : []),
    ]);
    this.channels.clear();
    this.sessionListeners.clear();
    this.connectionListeners.clear();
    this.store.close();
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "The browser client could not close all owned resources.");
  }
}
