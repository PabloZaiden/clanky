/**
 * No-history realtime sources maintained independently of browser connections.
 */
import { createLogger, type RealtimeBus, type RealtimePublication } from "@pablozaiden/webapp/server";
import { realtimeServerMessageSchema, type RealtimeInterest } from "@pablozaiden/webapp/contracts";
import { WorkspaceRealtimeFrameSchema } from "@/contracts/schemas/mesh-client";
import { decodeCollaborationResourceReference, encodeCollaborationResourceReference } from "@/shared/collaboration-reference";
import { DomainError, isDomainError } from "../domain/domain-error";
import type { MeshRelayDataStream } from "../core/mesh-relay-data-stream";
import { workspaceConnections, type WorkspaceConnectionRuntime } from "../core/workspace-connections";
import { workspaceEventReferenceFields } from "../core/workspace-event-authority";
import { qualifyWorkspaceResponse } from "../core/workspace-source-response";
import { WORKSPACE_REALTIME_RESOURCE_KINDS, isWorkspaceRealtimeEvent, type ClankyRealtimeEvent } from "../realtime";

const log = createLogger("api:workspace-realtime-source");
type Ready = Extract<ReturnType<typeof WorkspaceRealtimeFrameSchema.parse>, { type: "workspace.ready" }>;
const REFERENCE_TARGETS = new Set(["id", "scope", "workspaceId", "taskId", "chatId", "agentId", "agentRunId", "terminalSessionId", "previewId"]);

function remoteInterest(interest: RealtimeInterest, connectionId: string): RealtimeInterest | undefined {
  const result = { ...interest, kinds: interest.kinds.filter((kind) => kind !== "action") };
  if (!result.kinds.length) return undefined;
  if (result.resources) {
    result.resources = result.resources.filter((resource) => WORKSPACE_REALTIME_RESOURCE_KINDS[resource]);
    if (!result.resources.length) return undefined;
  }
  const decode = (value: string): string | undefined => {
    const ref = decodeCollaborationResourceReference(value);
    return ref?.connectionId === connectionId ? ref.resourceId : undefined;
  };
  for (const selector of ["ids", "scopes"] as const) {
    if (!result[selector]) continue;
    result[selector] = result[selector].flatMap((value) => {
      const id = decode(value);
      return id ? [id] : [];
    });
    if (!result[selector].length) return undefined;
  }
  if (result.targets) {
    result.targets = { ...result.targets };
    for (const [key, values] of Object.entries(result.targets)) {
      if (!REFERENCE_TARGETS.has(key)) continue;
      const ids = (Array.isArray(values) ? values : [values]).flatMap((value) => {
        const id = decode(value);
        return id ? [id] : [];
      });
      if (!ids.length) return undefined;
      result.targets[key] = ids;
    }
  }
  return result;
}

function qualifyPublication(
  runtime: WorkspaceConnectionRuntime,
  publication: RealtimePublication<unknown>,
): RealtimePublication<ClankyRealtimeEvent> | undefined {
  if (!isWorkspaceRealtimeEvent(publication.event)) return undefined;
  const qualify = (resourceKind: string, resourceId: string): string => encodeCollaborationResourceReference({
    connectionId: runtime.connection.id, resourceKind, resourceId,
  });
  const fields = workspaceEventReferenceFields(publication.target);
  const target = { ...publication.target };
  for (const [field, kind] of Object.entries(fields)) {
    if (target[field]) target[field] = qualify(kind, target[field]!);
  }
  delete target["membershipId"];
  const event = qualifyWorkspaceResponse(publication.event, {
    resource: fields["id"] ?? "workspace", qualify, qualifyUrl: (path) => path,
  });
  if (!isWorkspaceRealtimeEvent(event)) return undefined;
  if ("resource" in event) {
    if (event.id && fields["id"]) event.id = qualify(fields["id"], event.id);
    if (event.scope && fields["scope"]) event.scope = qualify(fields["scope"], event.scope);
  }
  return { ...publication, event, target };
}

class WorkspaceRealtimeSource {
  readonly finished: Promise<void>;
  private readonly abort = new AbortController();
  private readonly source;
  private readonly stopObserving: () => void;
  private stream?: MeshRelayDataStream;
  private ready?: Ready;
  private interests: readonly RealtimeInterest[] = [];
  private readonly subscriptions = new Map<string, string>();
  private serial = 0;

  constructor(
    realtime: RealtimeBus<ClankyRealtimeEvent>,
    private readonly runtime: WorkspaceConnectionRuntime,
  ) {
    this.source = realtime.attachSource({
      userId: runtime.localUserId,
      authorize: (publication) => Boolean(this.ready
        && publication.target.userId === this.ready.ownerUserId
        && publication.target["workspaceId"]
        && this.ready.workspaceIds.includes(publication.target["workspaceId"])
        && isWorkspaceRealtimeEvent(publication.event)),
      transform: (publication) => qualifyPublication(runtime, publication),
    });
    try {
      this.stopObserving = realtime.observeInterests(runtime.localUserId, (interests) => {
        this.interests = interests;
        this.flushInterests();
      }, {
        onError: (error) => {
          workspaceConnections.reportFailure(runtime, "collaboration_realtime_interests");
          log.error("Workspace realtime interest propagation failed", { error: String(error) });
          this.stream?.close(1011, "Workspace realtime interests failed");
        },
      });
    } catch (error) {
      this.source.dispose();
      throw error;
    }
    this.finished = this.maintain().finally(() => {
      this.stopObserving();
      this.source.dispose();
    });
  }

  private flushInterests(): void {
    if (!this.stream || !this.ready || this.abort.signal.aborted) return;
    const next = new Map<string, RealtimeInterest>();
    for (const interest of this.interests) {
      const value = remoteInterest(interest, this.runtime.connection.id);
      if (value) next.set(JSON.stringify(value), value);
    }
    if (next.size > 128) throw new DomainError("collaboration_connection_capacity", "Too many remote realtime interests.");
    for (const [key, subscriptionId] of this.subscriptions) {
      if (next.has(key)) continue;
      this.stream.send(JSON.stringify({ type: "unsubscribe", subscriptionId, generation: 2 }));
      this.subscriptions.delete(key);
    }
    for (const [key, interest] of next) {
      if (this.subscriptions.has(key)) continue;
      const subscriptionId = `workspace-${++this.serial}`;
      this.stream.send(JSON.stringify({ type: "subscribe", subscriptionId, generation: 1, interest }));
      this.subscriptions.set(key, subscriptionId);
    }
  }

  private async maintain(): Promise<void> {
    let delay = 250;
    while (!this.abort.signal.aborted) {
      try {
        await this.connect();
      } catch (error) {
        if (this.abort.signal.aborted) break;
        workspaceConnections.reportFailure(this.runtime, isDomainError(error) ? error.code : "collaboration_realtime_failed");
        log.warn("Workspace realtime disconnected", {
          connectionId: this.runtime.connection.id, error: String(error),
        });
      }
      if (this.abort.signal.aborted) break;
      this.source.invalidate();
      await this.wait(delay);
      delay = Math.min(delay * 2, 5_000);
    }
  }

  private async connect(): Promise<void> {
    const stream = await this.runtime.client.openSocket({ kind: "realtime", path: "/api/ws", signal: this.abort.signal });
    this.stream = stream;
    let heartbeat: Timer | undefined;
    try {
      const first = await stream.next(20_000);
      if (first.kind !== "text") throw new DomainError("collaboration_response_invalid", "Workspace realtime handshake missing.");
      const ready = WorkspaceRealtimeFrameSchema.parse(JSON.parse(first.text));
      if (ready.type === "workspace.error") {
        workspaceConnections.reportFailure(this.runtime, ready.code);
        throw new DomainError(ready.code, "Workspace realtime access is unavailable.");
      }
      if (ready.type !== "workspace.ready" || ready.guestId !== this.runtime.connection.guestId) {
        throw new DomainError("collaboration_response_invalid", "Workspace realtime identity mismatch.");
      }
      this.ready = ready;
      this.serial = 0;
      this.subscriptions.clear();
      this.flushInterests();
      workspaceConnections.reportHealthy(this.runtime);
      heartbeat = setInterval(() => {
        try {
          stream.send(JSON.stringify({ type: "ping" }));
        } catch (error) {
          log.warn("Workspace realtime heartbeat failed", { error: String(error) });
          stream.close(1011, "Workspace realtime heartbeat failed");
        }
      }, 25_000);
      heartbeat.unref();
      await this.read(stream);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.ready = undefined;
      this.stream = undefined;
      this.subscriptions.clear();
      stream.close(1000, "Workspace realtime source closed");
      stream.dispose();
    }
  }

  private async read(stream: MeshRelayDataStream): Promise<void> {
    while (!this.abort.signal.aborted) {
      const item = await stream.next();
      if (item.kind === "closed") {
        throw new DomainError("collaboration_realtime_disconnected", "The workspace realtime stream closed.");
      }
      if (item.kind !== "text") throw new DomainError("collaboration_response_invalid", "Invalid workspace realtime frame.");
      const raw: unknown = JSON.parse(item.text);
      const frame = WorkspaceRealtimeFrameSchema.safeParse(raw);
      if (!frame.success) {
        const control = realtimeServerMessageSchema.safeParse(raw);
        if (control.success && control.data.type === "error") {
          throw new DomainError("collaboration_realtime_subscription_failed",
            `Workspace realtime subscription failed (${control.data.code}).`);
        }
        if (!control.success || control.data.type === "event") {
          throw new DomainError("collaboration_response_invalid", "Invalid workspace realtime response.");
        }
      } else if (frame.data.type === "workspace.publication") {
        if (!isWorkspaceRealtimeEvent(frame.data.publication.event)) {
          throw new DomainError("collaboration_response_invalid", "Invalid workspace realtime event.");
        }
        this.source.publish(frame.data.publication.event, {
          kind: frame.data.publication.kind, target: frame.data.publication.target,
        });
      } else throw new DomainError("collaboration_response_invalid", "Unexpected workspace realtime handshake.");
    }
  }

  private async wait(milliseconds: number): Promise<void> {
    if (this.abort.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      this.abort.signal.addEventListener("abort", finish, { once: true });
    });
  }

  close(): void {
    this.abort.abort();
    this.stream?.close(1000, "Workspace realtime stopped");
    this.stream?.dispose();
    this.source.invalidate();
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
    if (runtime.connection.status !== "active" || runtime.client.status !== "connected") {
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
