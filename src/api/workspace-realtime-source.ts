/**
 * Attach the shared invited realtime client to the authoritative local user bus.
 */
import { createLogger, type RealtimeBus } from "@pablozaiden/webapp/server";
import type { RealtimeInterest } from "@pablozaiden/webapp/contracts";
import type { ClankyRealtimeEvent } from "@/shared/realtime";
import { workspaceConnections, type WorkspaceConnectionRuntime } from "../core/workspace-connections";
import { CollaborationRealtimeSource } from "../client-sdk/collaboration/realtime";
import { qualifyCollaborationPublication } from "../client-sdk/collaboration/realtime-policy";

const log = createLogger("api:workspace-realtime-source");

class WorkspaceRealtimeSource {
  readonly finished: Promise<void>;
  private readonly upstream: CollaborationRealtimeSource;

  constructor(realtime: RealtimeBus<ClankyRealtimeEvent>, runtime: WorkspaceConnectionRuntime) {
    let upstream: CollaborationRealtimeSource | undefined;
    let interests: readonly RealtimeInterest[] = [];
    const source = realtime.attachSource({
      userId: runtime.scope,
      authorize: (publication) => upstream?.authorize(publication) ?? false,
      transform: (publication) => qualifyCollaborationPublication(runtime.connection.id, publication),
    });
    let stopObserving: () => void;
    try {
      stopObserving = realtime.observeInterests(runtime.scope, (next) => {
        interests = next;
        upstream?.setInterests(next);
      }, {
        onError: (error) => {
          // The synchronous bus callback owns the resulting asynchronous failure.
          void workspaceConnections.reportFailure(runtime, "collaboration_realtime_interests")
            .catch((failure: unknown) => log.error("Workspace realtime failure handling failed", { error: String(failure) }));
          log.error("Workspace realtime interest propagation failed", { error: String(error) });
          upstream?.close();
        },
      });
    } catch (error) {
      source.dispose();
      throw error;
    }
    this.upstream = upstream = new CollaborationRealtimeSource({
      runtime, interests, logger: log,
      publish: (publication) => source.publish(publication.event, {
        kind: publication.kind, target: publication.target,
      }),
      invalidate: () => source.invalidate(),
      reportFailure: async (current, code) => await workspaceConnections.reportFailure(current, code),
      reportHealthy: (current) => workspaceConnections.reportHealthy(current),
    });
    this.finished = upstream.finished.finally(() => {
      stopObserving();
      source.dispose();
    });
  }

  close(): void {
    this.upstream.close();
  }
}

class WorkspaceRealtimeSources {
  private realtime?: RealtimeBus<ClankyRealtimeEvent>;
  private readonly sources = new Map<string, { runtime: WorkspaceConnectionRuntime; source: WorkspaceRealtimeSource }>();
  private readonly pending = new Set<Promise<void>>();

  configure(realtime: RealtimeBus<ClankyRealtimeEvent>): void {
    this.realtime = realtime;
  }

  update(runtime: WorkspaceConnectionRuntime): void {
    const previous = this.sources.get(runtime.connection.id);
    if (runtime.connection.status !== "active"
      || runtime.connection.controllerUrl === undefined && runtime.client.status !== "connected") {
      previous?.source.close();
      this.sources.delete(runtime.connection.id);
      return;
    }
    if (previous?.runtime === runtime) return;
    previous?.source.close();
    if (!this.realtime) throw new Error("Workspace realtime sources are not configured.");
    const source = new WorkspaceRealtimeSource(this.realtime, runtime);
    this.sources.set(runtime.connection.id, { runtime, source });
    const pending = source.finished.catch((error: unknown) => {
      log.error("Workspace realtime maintenance failed", { error: String(error) });
    }).finally(() => this.pending.delete(pending));
    this.pending.add(pending);
  }

  remove(connectionId: string): void {
    this.sources.get(connectionId)?.source.close();
    this.sources.delete(connectionId);
  }

  async stop(): Promise<void> {
    for (const { source } of this.sources.values()) source.close();
    this.sources.clear();
    await Promise.all([...this.pending]);
  }
}

export const workspaceRealtimeSources = new WorkspaceRealtimeSources();
