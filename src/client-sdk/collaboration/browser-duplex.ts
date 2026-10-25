/**
 * Framework message-channel adapter for an actual invited terminal stream.
 */

import type { WebAppDuplex, WebAppDuplexHandlers } from "@pablozaiden/webapp/web";
import { utf8ByteLength } from "@/shared/encoding";
import { DomainError } from "../../domain/domain-error";
import type { CollaborationClientRuntime } from "./engine";
import type { CollaborationClientLogger } from "./types";
import {
  CollaborationSocketBridge, COLLABORATION_SOCKET_MAX_PENDING_BYTES,
  COLLABORATION_SOCKET_MAX_PENDING_FRAMES, type CollaborationSocketOperation,
} from "./socket";

export class BrowserCollaborationDuplex implements WebAppDuplex {
  readonly ready: Promise<void>;
  private readonly bridge: CollaborationSocketBridge;
  private readonly subscribers = new Set<WebAppDuplexHandlers>();
  private readonly pending: Array<string | ArrayBuffer> = [];
  private pendingBytes = 0;
  private ended?: { code: number; reason: string };
  private closing?: Promise<void>;
  private readonly aborted: () => void;

  constructor(options: {
    runtime: CollaborationClientRuntime;
    operation: CollaborationSocketOperation;
    signal?: AbortSignal;
    logger?: CollaborationClientLogger;
    closed?(): void;
  }) {
    const log = options.logger ?? console;
    this.bridge = new CollaborationSocketBridge(options.runtime, options.operation, log);
    this.ready = this.bridge.ready;
    this.aborted = () => {
      void this.close(1000, "Terminal connection cancelled").catch((error: unknown) => {
        log.error("The cancelled terminal transport did not close", { error: String(error) });
      });
    };
    this.bridge.start({
      send: (data) => {
        if (this.ended) return 0;
        const value = typeof data === "string" ? data : new Uint8Array(data).buffer;
        if (!this.subscribers.size) {
          const size = typeof value === "string" ? utf8ByteLength(value) : value.byteLength;
          if (this.pendingBytes + size > COLLABORATION_SOCKET_MAX_PENDING_BYTES
            || this.pending.length >= COLLABORATION_SOCKET_MAX_PENDING_FRAMES) {
            throw new DomainError("collaboration_connection_capacity", "Attach the terminal consumer before reading output.");
          }
          this.pending.push(value);
          this.pendingBytes += size;
        } else {
          for (const subscriber of this.subscribers) this.deliver(subscriber, () => subscriber.onMessage(value), log);
        }
        return 1;
      },
      close: (code = 1000, reason = "") => {
        if (this.ended) return;
        this.ended = { code, reason };
        options.signal?.removeEventListener("abort", this.aborted);
        for (const subscriber of this.subscribers) this.deliver(subscriber, () => subscriber.onClose(this.ended!), log);
        this.subscribers.clear();
        options.closed?.();
      },
      getBufferedAmount: () => this.pendingBytes,
    });
    options.signal?.addEventListener("abort", this.aborted, { once: true });
    if (options.signal?.aborted) this.aborted();
    this.log = log;
  }

  private readonly log: CollaborationClientLogger;

  get bufferedAmount(): number {
    return this.bridge.bufferedAmount;
  }

  subscribe(handlers: WebAppDuplexHandlers): () => void {
    if (this.subscribers.size >= COLLABORATION_SOCKET_MAX_PENDING_FRAMES) {
      throw new DomainError("collaboration_connection_capacity", "Too many terminal consumers.");
    }
    const frames = this.pending.splice(0);
    this.pendingBytes = 0;
    const ended = this.ended;
    let active = true;
    if (!ended) this.subscribers.add(handlers);
    queueMicrotask(() => {
      if (!active) return;
      for (const frame of frames) {
        if (!active) return;
        this.deliver(handlers, () => handlers.onMessage(frame), this.log);
      }
      if (active && ended) this.deliver(handlers, () => handlers.onClose(ended), this.log);
    });
    return () => { active = false; this.subscribers.delete(handlers); };
  }

  private deliver(handlers: WebAppDuplexHandlers, action: () => void, log: CollaborationClientLogger): void {
    try {
      action();
    } catch (error) {
      log.error("Terminal consumer failed", { error: String(error) });
      try {
        handlers.onError(error instanceof Error ? error : new Error(String(error)));
      } catch (failure) {
        log.error("Terminal consumer could not receive its error", { error: String(failure) });
      }
    }
  }

  async send(data: string | ArrayBuffer | Uint8Array): Promise<void> {
    await this.ready;
    if (this.ended) throw new DomainError("collaboration_disconnected", "The terminal channel is closed.");
    this.bridge.send(typeof data === "string" || data instanceof Uint8Array ? data : new Uint8Array(data));
  }

  async close(code = 1000, reason = ""): Promise<void> {
    if (!this.closing) this.closing = this.bridge.stop(code, reason);
    try {
      await this.closing;
    } finally {
      this.pending.length = 0;
      this.pendingBytes = 0;
    }
  }
}
