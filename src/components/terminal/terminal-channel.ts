/**
 * Owns terminal opening, subscription and deterministic duplex shutdown.
 */

import type { WebAppDuplex, WebAppDuplexHandlers } from "@pablozaiden/webapp/web";
import { appDuplexConnection } from "../../lib/public-path";
import { MESH_TERMINAL_WEBSOCKET_OPEN_TIMEOUT_MS } from "@/shared/mesh-terminal";

export class TerminalChannel {
  private readonly controller = new AbortController();
  private channel?: WebAppDuplex;
  private unsubscribe?: () => void;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private stopping?: Promise<void>;
  private cleanupFailure?: { error: unknown };

  constructor(private readonly options: WebAppDuplexHandlers & {
    path: string;
    onChannel: (channel: WebAppDuplex) => void;
    onReady: (channel: WebAppDuplex) => Promise<void>;
  }) {}

  start(): Promise<void> {
    this.controller.signal.throwIfAborted();
    this.opening ??= this.open();
    return this.opening;
  }

  private async open(): Promise<void> {
    const timeout = setTimeout(() => this.controller.abort(new Error("Terminal connection timed out.")),
      MESH_TERMINAL_WEBSOCKET_OPEN_TIMEOUT_MS);
    try {
      this.channel = await appDuplexConnection(this.options.path, { signal: this.controller.signal });
      this.controller.signal.throwIfAborted();
      this.unsubscribe = this.channel.subscribe(this.options);
      this.options.onChannel(this.channel);
      await this.channel.ready;
      this.controller.signal.throwIfAborted();
      await this.options.onReady(this.channel);
    } catch (error) {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      try {
        await this.closeChannel();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "Terminal startup and shutdown failed.", { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private closeChannel(): Promise<void> {
    if (!this.channel) return Promise.resolve();
    this.closing ??= this.channel.close().catch((error: unknown) => {
      this.cleanupFailure = { error };
      throw error;
    });
    return this.closing;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.controller.abort();
    this.stopping = (async () => {
      // A channel can arrive after cancellation; open owns closing that late result.
      await Promise.allSettled([this.opening, this.closeChannel()]);
      if (this.cleanupFailure) throw this.cleanupFailure.error;
    })();
    return this.stopping;
  }
}
