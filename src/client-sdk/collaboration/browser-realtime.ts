/**
 * Framework subscriber adapter over the shared invited realtime lifecycle.
 */

import {
  realtimeInterestMatches, realtimeInterestSchema,
  type RealtimeInterest, type RealtimePublication,
} from "@pablozaiden/webapp/contracts";
import type { RealtimeSource, RealtimeSubscriber, RealtimeStatus } from "@pablozaiden/webapp/web";
import type { ClankyRealtimeEvent } from "@/shared/realtime";
import { DomainError } from "../../domain/domain-error";
import type { CollaborationClientEngine, CollaborationClientRuntime } from "./engine";
import type { CollaborationClientLogger } from "./types";
import { CollaborationRealtimeSource } from "./realtime";
import { collaborationRemoteInterest, qualifyCollaborationPublication } from "./realtime-policy";

interface Subscription extends RealtimeSubscriber<unknown> {
  activation: number;
  key?: string;
  status?: RealtimeStatus;
}

const MAX_SUBSCRIBERS = 512;

export class BrowserCollaborationRealtime {
  private readonly subscribers = new Set<Subscription>();
  private readonly sources = new Map<string, { runtime: CollaborationClientRuntime; source: CollaborationRealtimeSource }>();
  private readonly pending = new Set<Promise<void>>();
  private disposed = false;

  constructor(
    private readonly engine: CollaborationClientEngine,
    private readonly log: CollaborationClientLogger = console,
  ) {}

  createSource(): RealtimeSource {
    const leases = new Set<() => void>();
    let disposed = false;
    return {
      subscribe: <TEvent>(subscriber: RealtimeSubscriber<TEvent>): (() => void) => {
        if (disposed) throw new DomainError("collaboration_disconnected", "This realtime subscription source is closed.");
        const unsubscribe = this.subscribe(subscriber);
        const release = (): void => { unsubscribe(); leases.delete(release); };
        leases.add(release);
        return release;
      },
      recoverFromNetworkFailure: () => {
        if (disposed) return;
        this.resynchronize();
      },
      dispose: () => {
        disposed = true;
        for (const release of leases) release();
      },
    };
  }

  update(runtime: CollaborationClientRuntime): void {
    if (this.disposed) return;
    if (runtime.connection.status !== "active"
      || runtime.connection.controllerUrl === undefined && runtime.client.status !== "connected") {
      this.remove(runtime.connection.id);
      return;
    }
    const previous = this.sources.get(runtime.connection.id);
    if (previous?.runtime === runtime) return;
    previous?.source.close();
    const source = new CollaborationRealtimeSource({
      runtime, logger: this.log, interests: this.interests(),
      reportFailure: async (current, code) => await this.engine.reportFailure(current, code),
      reportHealthy: (current) => this.engine.reportHealthy(current),
      invalidate: () => this.notify(),
      subscribed: () => this.notify(),
      publish: (publication) => this.publish(runtime.connection.id, publication),
    });
    this.sources.set(runtime.connection.id, { runtime, source });
    const pending = source.finished.catch((error: unknown) => {
      this.log.error("Browser workspace realtime failed", { error: String(error) });
      for (const subscriber of this.subscribers) {
        if (collaborationRemoteInterest(subscriber.interest, runtime.connection.id)) this.notifyError(subscriber, error);
      }
    }).finally(() => this.pending.delete(pending));
    this.pending.add(pending);
    this.notify();
  }

  remove(connectionId: string): void {
    this.sources.get(connectionId)?.source.close();
    this.sources.delete(connectionId);
    this.notify();
  }

  refresh(): void {
    for (const subscriber of this.subscribers) subscriber.key = undefined;
    this.notify();
  }

  resynchronize(): void {
    if (this.disposed) return;
    for (const { source } of this.sources.values()) source.interrupt();
  }

  private subscribe<TEvent>(subscriber: RealtimeSubscriber<TEvent>): () => void {
    if (this.disposed) throw new DomainError("collaboration_disconnected", "The collaboration client is closed.");
    if (this.subscribers.size >= MAX_SUBSCRIBERS) {
      throw new DomainError("collaboration_connection_capacity", "Too many browser realtime consumers.");
    }
    const record: Subscription = {
      ...subscriber, interest: realtimeInterestSchema.parse(subscriber.interest), activation: 0,
      onEvent: (event) => subscriber.onEvent(event as TEvent),
    };
    this.subscribers.add(record);
    try {
      this.syncInterests();
    } catch (error) {
      this.subscribers.delete(record);
      this.syncInterests();
      throw error;
    }
    this.notify();
    return () => {
      if (!this.subscribers.delete(record)) return;
      try {
        this.syncInterests();
      } catch (error) {
        this.log.error("Browser realtime interests could not be retired", { error: String(error) });
        this.report(record, error);
      }
    };
  }

  private interests(): RealtimeInterest[] {
    return [...new Map([...this.subscribers].map((item) => [JSON.stringify(item.interest), item.interest])).values()];
  }

  private syncInterests(): void {
    const interests = this.interests();
    for (const { source } of this.sources.values()) source.setInterests(interests);
  }

  private notify(): void {
    if (this.disposed) return;
    const runtimes = this.engine.activeRuntimes();
    for (const subscriber of this.subscribers) {
      const eligible = runtimes.filter((runtime) => collaborationRemoteInterest(subscriber.interest, runtime.connection.id));
      const acknowledged = eligible.flatMap((runtime) => {
        const source = this.sources.get(runtime.connection.id)?.source;
        return source?.acknowledged(subscriber.interest) ? [`${runtime.connection.id}:${source.activation}`] : [];
      });
      const status = eligible.length > 0 && acknowledged.length === 0 ? "connecting" : "open";
      const key = JSON.stringify([eligible.map((runtime) => runtime.connection.id).sort(), acknowledged.sort()]);
      try {
        if (subscriber.status !== status) {
          subscriber.status = status;
          subscriber.onStatus?.(status);
        }
        if (status === "open" && subscriber.key !== key && this.subscribers.has(subscriber)) {
          subscriber.key = key;
          const generation = ++subscriber.activation;
          // Refetch consumers own their async work; never block the relay read loop.
          void Promise.resolve().then(async () => {
            if (this.subscribers.has(subscriber) && subscriber.activation === generation) {
              await subscriber.onSubscribed?.({ generation });
            }
          }).catch((error: unknown) => this.report(subscriber, error));
        }
      } catch (error) {
        this.report(subscriber, error);
      }
    }
  }

  private publish(connectionId: string, original: RealtimePublication<ClankyRealtimeEvent>): void {
    const publication = qualifyCollaborationPublication(connectionId, original);
    if (!publication) return;
    for (const subscriber of this.subscribers) {
      if (!this.sources.get(connectionId)?.source.acknowledged(subscriber.interest)
        || !realtimeInterestMatches(subscriber.interest, publication.kind, publication.event, publication.target)) continue;
      try {
        subscriber.onEvent(publication.event);
      } catch (error) {
        this.report(subscriber, error);
      }
    }
  }

  private report(subscriber: Subscription, error: unknown): void {
    this.log.error("Browser realtime consumer failed", { error: String(error) });
    this.notifyError(subscriber, error);
  }

  private notifyError(subscriber: Subscription, error: unknown): void {
    try {
      if (this.subscribers.has(subscriber)) subscriber.onError?.(error instanceof Error ? error : new Error(String(error)));
    } catch (failure) {
      this.log.error("Browser realtime consumer could not receive its error", { error: String(failure) });
    }
  }

  async stop(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const { source } of this.sources.values()) source.close();
    this.sources.clear();
    for (const subscriber of this.subscribers) {
      try {
        subscriber.onStatus?.("closed");
      } catch (error) {
        this.report(subscriber, error);
      }
    }
    this.subscribers.clear();
    await Promise.all([...this.pending]);
  }
}
