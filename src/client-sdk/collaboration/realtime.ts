/**
 * No-history invited realtime lifecycle, independent of host bus or browser UI.
 */

import {
  MAX_REALTIME_SUBSCRIPTIONS, realtimeServerMessageSchema,
  type RealtimeInterest, type RealtimePublication,
} from "@pablozaiden/webapp/contracts";
import { WorkspaceRealtimeFrameSchema } from "@/contracts/schemas/mesh-client";
import { isWorkspaceRealtimeEvent, type ClankyRealtimeEvent } from "@/shared/realtime";
import { DomainError, isDomainError } from "../../domain/domain-error";
import type { MeshRelayDataStream } from "../../core/mesh-relay-data-stream";
import type { CollaborationClientRuntime } from "./engine";
import type { CollaborationClientLogger } from "./types";
import { collaborationRemoteInterest } from "./realtime-policy";

type Ready = Extract<ReturnType<typeof WorkspaceRealtimeFrameSchema.parse>, { type: "workspace.ready" }>;

export interface CollaborationRealtimeOptions {
  runtime: CollaborationClientRuntime;
  logger?: CollaborationClientLogger;
  interests?: readonly RealtimeInterest[];
  reportFailure(runtime: CollaborationClientRuntime, code: string): Promise<void>;
  reportHealthy(runtime: CollaborationClientRuntime): void;
  publish(publication: RealtimePublication<ClankyRealtimeEvent>): void;
  invalidate(): void;
  subscribed?(interest: RealtimeInterest, generation: number): void;
}

export class CollaborationRealtimeSource {
  readonly finished: Promise<void>;
  private readonly abort = new AbortController();
  private readonly log: CollaborationClientLogger;
  private stream?: MeshRelayDataStream;
  private ready?: Ready;
  private interests: readonly RealtimeInterest[];
  private readonly subscriptions = new Map<string, { id: string; interest: RealtimeInterest; acknowledged: boolean }>();
  private serial = 0;
  private generation = 0;

  constructor(private readonly options: CollaborationRealtimeOptions) {
    this.log = options.logger ?? console;
    this.interests = options.interests ?? [];
    this.finished = this.maintain();
  }

  authorize(publication: Readonly<RealtimePublication>): boolean {
    return Boolean(!this.abort.signal.aborted && this.ready
      && publication.target.userId === this.ready.ownerUserId
      && publication.target["workspaceId"]
      && this.ready.workspaceIds.includes(publication.target["workspaceId"])
      && isWorkspaceRealtimeEvent(publication.event));
  }

  setInterests(interests: readonly RealtimeInterest[]): void {
    this.interests = interests;
    this.flushInterests();
  }

  acknowledged(interest: RealtimeInterest): boolean {
    const remote = collaborationRemoteInterest(interest, this.options.runtime.connection.id);
    return Boolean(!this.abort.signal.aborted && this.ready && remote
      && this.subscriptions.get(JSON.stringify(remote))?.acknowledged);
  }

  get activation(): number {
    return this.generation;
  }

  interrupt(): void {
    if (this.abort.signal.aborted) return;
    this.ready = undefined;
    this.subscriptions.clear();
    this.stream?.abort(1012, "Workspace realtime resynchronization");
    this.options.invalidate();
  }

  private flushInterests(): void {
    if (!this.stream || !this.ready || this.abort.signal.aborted) return;
    const next = new Map<string, RealtimeInterest>();
    for (const interest of this.interests) {
      const value = collaborationRemoteInterest(interest, this.options.runtime.connection.id);
      if (value) next.set(JSON.stringify(value), value);
    }
    if (next.size > MAX_REALTIME_SUBSCRIPTIONS) {
      throw new DomainError("collaboration_connection_capacity", "Too many remote realtime interests.");
    }
    for (const [key, subscription] of this.subscriptions) {
      if (next.has(key)) continue;
      this.stream.send(JSON.stringify({ type: "unsubscribe", subscriptionId: subscription.id, generation: 2 }));
      this.subscriptions.delete(key);
    }
    for (const [key, interest] of next) {
      if (this.subscriptions.has(key)) continue;
      const id = `workspace-${++this.serial}`;
      this.stream.send(JSON.stringify({ type: "subscribe", subscriptionId: id, generation: 1, interest }));
      this.subscriptions.set(key, { id, interest, acknowledged: false });
    }
  }

  private async maintain(): Promise<void> {
    let delay = 250;
    while (!this.abort.signal.aborted) {
      try {
        await this.connect();
      } catch (error) {
        if (this.abort.signal.aborted && isDomainError(error) && error.code === "mesh_relay_transport_cleanup_failed") throw error;
        if (this.abort.signal.aborted) break;
        const code = isDomainError(error) ? error.code : "collaboration_realtime_failed";
        await this.options.reportFailure(this.options.runtime, code);
        if (code === "mesh_relay_transport_cleanup_failed") throw error;
        this.log.warn("Workspace realtime disconnected", {
          connectionId: this.options.runtime.connection.id, error: String(error),
        });
      }
      if (this.abort.signal.aborted) break;
      this.options.invalidate();
      await this.wait(delay);
      delay = Math.min(delay * 2, 5_000);
    }
  }

  private async connect(): Promise<void> {
    const stream = await this.options.runtime.client.openSocket({
      kind: "realtime", path: "/api/ws", signal: this.abort.signal,
    });
    this.stream = stream;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      this.abort.signal.throwIfAborted();
      const first = await stream.next(20_000);
      if (first.kind !== "text") throw new DomainError("collaboration_response_invalid", "Workspace realtime handshake missing.");
      const parsed = WorkspaceRealtimeFrameSchema.safeParse(this.parse(first.text));
      if (!parsed.success) throw new DomainError("collaboration_response_invalid", "Invalid workspace realtime handshake.");
      const ready = parsed.data;
      if (ready.type === "workspace.error") throw new DomainError(ready.code, "Workspace realtime access is unavailable.");
      if (ready.type !== "workspace.ready" || ready.guestId !== this.options.runtime.connection.guestId) {
        throw new DomainError("collaboration_response_invalid", "Workspace realtime identity mismatch.");
      }
      this.ready = ready;
      this.generation++;
      this.serial = 0;
      this.subscriptions.clear();
      this.flushInterests();
      this.options.reportHealthy(this.options.runtime);
      heartbeat = setInterval(() => {
        try {
          stream.send(JSON.stringify({ type: "ping" }));
        } catch (error) {
          this.log.warn("Workspace realtime heartbeat failed", { error: String(error) });
          stream.abort(1011, "Workspace realtime heartbeat failed");
        }
      }, 25_000);
      await this.read(stream);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.ready = undefined;
      this.stream = undefined;
      this.subscriptions.clear();
      stream.abort(1000, "Workspace realtime source closed");
      try {
        await stream.waitUntilTransportClosed();
      } catch (cause) {
        throw new DomainError("mesh_relay_transport_cleanup_failed", "The realtime transport did not close.", { cause });
      } finally {
        stream.dispose();
      }
    }
  }

  private parse(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new DomainError("collaboration_response_invalid", "Invalid workspace realtime JSON.", { cause });
    }
  }

  private async read(stream: MeshRelayDataStream): Promise<void> {
    while (!this.abort.signal.aborted) {
      const item = await stream.next();
      if (item.kind === "closed") {
        throw new DomainError("collaboration_realtime_disconnected", "The workspace realtime stream closed.");
      }
      if (item.kind !== "text") throw new DomainError("collaboration_response_invalid", "Invalid workspace realtime frame.");
      const raw = this.parse(item.text);
      const frame = WorkspaceRealtimeFrameSchema.safeParse(raw);
      if (!frame.success) {
        this.readControl(raw);
      } else if (frame.data.type === "workspace.publication") {
        const publication = frame.data.publication;
        if (!isWorkspaceRealtimeEvent(publication.event)) {
          throw new DomainError("collaboration_response_invalid", "Invalid workspace realtime event.");
        }
        if (this.authorize(publication)) this.options.publish({ ...publication, event: publication.event });
      } else throw new DomainError("collaboration_response_invalid", "Unexpected workspace realtime handshake.");
    }
  }

  private readControl(raw: unknown): void {
    const control = realtimeServerMessageSchema.safeParse(raw);
    if (control.success && control.data.type === "error") {
      throw new DomainError("collaboration_realtime_subscription_failed",
        `Workspace realtime subscription failed (${control.data.code}).`);
    }
    if (!control.success || control.data.type === "event") {
      throw new DomainError("collaboration_response_invalid", "Invalid workspace realtime response.");
    }
    if (control.data.type !== "subscribed" || control.data.generation !== 1) return;
    for (const subscription of this.subscriptions.values()) {
      if (subscription.id !== control.data.subscriptionId || subscription.acknowledged) continue;
      subscription.acknowledged = true;
      this.options.subscribed?.(subscription.interest, this.generation);
      return;
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
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    this.stream?.abort(1000, "Workspace realtime stopped");
    this.options.invalidate();
  }
}
