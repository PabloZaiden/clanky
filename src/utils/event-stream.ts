/**
 * EventStream<T> - A simple async stream for event consumption.
 *
 * This provides a clean alternative to AsyncIterable/AsyncIterator,
 * using standard Promise-based async/await patterns.
 *
 * Usage:
 * ```typescript
 * const stream = await backend.subscribeToEvents(sessionId);
 * let event = await stream.next();
 * while (event !== null) {
 *   // handle event
 *   event = await stream.next();
 * }
 * ```
 */

import { createLogger } from "@pablozaiden/webapp/server";

const log = createLogger("EventStream");

/**
 * A simple async stream interface.
 * - `next()` returns the next item, or null when stream ends
 * - `close()` closes the stream early
 */
export interface EventStream<T> {
  /**
   * Get the next item from the stream.
   * Returns null when the stream has ended.
   */
  next(): Promise<T | null>;

  /**
   * Close the stream early (e.g., when aborting).
   */
  close(): void;
}

/** Default maximum buffer size for event streams */
const DEFAULT_MAX_BUFFER_SIZE = 10_000;

/**
 * Options for creating an event stream.
 */
export interface EventStreamOptions {
  /**
   * Maximum number of items to buffer before dropping oldest items.
   * When the buffer exceeds this limit, the oldest items are evicted
   * to make room for new ones. Defaults to 10,000.
   * Values less than 1 are clamped to 1; non-integer values are floored.
   */
  maxBufferSize?: number;
}

type EventStreamTerminalState =
  | { status: "ended" }
  | { status: "failed"; error: Error }
  | { status: "closed" };

type EventStreamState =
  | { status: "open" }
  | EventStreamTerminalState;

/**
 * Create an EventStream from a source that pushes events.
 * The producer calls `push()` for each event and `end()` when done.
 *
 * @param options - Optional configuration for the stream
 */
export function createEventStream<T>(options?: EventStreamOptions): {
  stream: EventStream<T>;
  push: (item: T) => void;
  end: () => void;
  fail: (error: Error) => void;
} {
  const maxBufferSize = Math.max(1, Math.floor(options?.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE));
  const items: T[] = [];
  const waiters: Array<{
    resolve: (value: T | null) => void;
    reject: (error: Error) => void;
  }> = [];
  let state: EventStreamState = { status: "open" };
  let droppedCount = 0;

  // Generate a unique ID for this stream instance for tracing
  const streamId = Math.random().toString(36).substring(2, 8);
  log.trace("Creating new event stream", { streamId, maxBufferSize });

  function transition(nextState: EventStreamTerminalState): boolean {
    if (state.status !== "open") {
      return false;
    }

    state = nextState;
    if (nextState.status === "failed") {
      for (const waiter of waiters) {
        waiter.reject(nextState.error);
      }
    } else {
      for (const waiter of waiters) {
        waiter.resolve(null);
      }
    }
    waiters.length = 0;
    return true;
  }

  function push(item: T): void {
    if (state.status !== "open") {
      log.trace("Push ignored (stream not open)", { streamId, state: state.status });
      return;
    }

    const waiter = waiters.shift();
    if (waiter) {
      log.trace("Push: resolving waiting consumer", { streamId });
      waiter.resolve(item);
    } else {
      // Evict oldest items if buffer is full
      if (items.length >= maxBufferSize) {
        const evictCount = Math.max(1, Math.floor(maxBufferSize * 0.1));
        items.splice(0, evictCount);
        droppedCount += evictCount;
        log.debug("Push: buffer full, evicted oldest items", {
          streamId,
          evictCount,
          totalDropped: droppedCount,
          maxBufferSize,
        });
      }
      log.trace("Push: buffering item", { streamId, bufferSize: items.length + 1 });
      items.push(item);
    }
  }

  function end(): void {
    const pendingWaiters = waiters.length;
    if (!transition({ status: "ended" })) {
      log.trace("End ignored (stream already terminal)", { streamId, state: state.status });
      return;
    }
    log.trace("Stream ending", { streamId, pendingWaiters });
  }

  function fail(err: Error): void {
    const pendingWaiters = waiters.length;
    if (!transition({ status: "failed", error: err })) {
      log.trace("Fail ignored (stream already terminal)", { streamId, state: state.status });
      return;
    }
    log.debug("Stream failing", { streamId, error: err.message, pendingWaiters });
  }

  const stream: EventStream<T> = {
    async next(): Promise<T | null> {
      if (state.status === "failed") {
        log.trace("Next: throwing stored error", { streamId, error: state.error.message });
        throw state.error;
      }

      if (state.status === "closed") {
        log.trace("Next: returning null (stream closed)", { streamId });
        return null;
      }

      const item = items.shift();
      if (item !== undefined) {
        log.trace("Next: returning buffered item", { streamId, remainingBuffer: items.length });
        return item;
      }

      if (state.status === "ended") {
        log.trace("Next: returning null (stream ended)", { streamId });
        return null;
      }

      log.trace("Next: waiting for item", { streamId, queuePosition: waiters.length + 1 });
      return new Promise<T | null>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },

    close(): void {
      log.trace("Stream closing", { streamId, pendingWaiters: waiters.length });
      transition({ status: "closed" });
    },
  };

  return { stream, push, end, fail };
}
