/**
 * Owns one native conversation subscription independently of its executions.
 */

import type { Backend } from "../backends/types";
import type { HarnessEvent } from "@/shared/harness-events";
import { HarnessError } from "../backends/harness-errors";
import type { EventStream } from "../utils/event-stream";
import { createLogger } from "@pablozaiden/webapp/server";

const log = createLogger("native-chat-observer");

export class NativeChatObserver {
  private closed = false;
  private operations = Promise.resolve();
  private pendingOperations = 0;
  private stream?: EventStream<HarnessEvent>;
  completion: Promise<void> = Promise.resolve();

  get isClosed(): boolean {
    return this.closed;
  }

  async start(options: {
    backend: Backend;
    sessionId: string;
    recover: () => Promise<void>;
    onEvent: (event: HarnessEvent) => Promise<void>;
    onFailure: (error: unknown) => Promise<void>;
    onClosed: () => void;
  }): Promise<void> {
    this.stream = await options.backend.subscribeToEvents(options.sessionId);
    try {
      await this.serialize(options.recover);
    } catch (error) {
      this.close();
      throw error;
    }
    // Session-lived work reports failures through persisted chat state; callers
    // await admission, not the potentially indefinite conversation lifetime.
    this.completion = this.consume(options).catch((error: unknown) => {
      log.error("Unable to persist native conversation observation failure", { sessionId: options.sessionId, error: String(error) });
    }).finally(options.onClosed);
  }

  serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new HarnessError("harness_transport_closed", "Native conversation observation is closed."));
    if (this.pendingOperations >= 1000) {
      return Promise.reject(new HarnessError("harness_event_gap", "Native conversation operation capacity was exceeded."));
    }
    this.pendingOperations++;
    const result = this.operations.then(async () => {
      if (this.closed) throw new HarnessError("harness_transport_closed", "Native conversation observation is closed.");
      return operation();
    });
    this.operations = result.then(() => {}, () => {}).finally(() => { this.pendingOperations--; });
    return result;
  }

  close(): void {
    this.closed = true;
    this.stream?.close();
  }

  private async consume(options: {
    onEvent: (event: HarnessEvent) => Promise<void>;
    onFailure: (error: unknown) => Promise<void>;
  }): Promise<void> {
    try {
      while (!this.closed) {
        const event = await this.stream!.next();
        if (this.closed) break;
        if (!event) throw new HarnessError("harness_transport_closed", "Native conversation observation ended.");
        await this.serialize(() => options.onEvent(event));
      }
    } catch (error) {
      if (!this.closed) {
        try {
          await this.serialize(() => options.onFailure(error));
        } catch (failure) {
          // Explicit teardown can close an observation queued behind admission.
          if (!this.closed) throw failure;
        }
      }
    } finally {
      this.close();
    }
  }
}
