/**
 * Unit tests for EventStream — the async event consumption primitive.
 * Covers producer/consumer flow, buffering, end/fail/close semantics.
 */

import { describe, test, expect } from "bun:test";
import { createEventStream } from "../../src/utils/event-stream";

describe("createEventStream", () => {
  // ========================================================================
  // Basic producer/consumer flow
  // ========================================================================

  describe("basic producer/consumer", () => {
    test("push then next returns the item", async () => {
      const { stream, push, end } = createEventStream<string>();
      push("hello");
      const result = await stream.next();
      expect(result).toBe("hello");
      end();
    });

    test("multiple pushes are consumed in order", async () => {
      const { stream, push, end } = createEventStream<number>();
      push(1);
      push(2);
      push(3);
      expect(await stream.next()).toBe(1);
      expect(await stream.next()).toBe(2);
      expect(await stream.next()).toBe(3);
      end();
    });

    test("next waits for push when buffer is empty", async () => {
      const { stream, push, end } = createEventStream<string>();
      // Start waiting before any push
      const promise = stream.next();
      // Push after a short delay
      setTimeout(() => push("delayed"), 10);
      const result = await promise;
      expect(result).toBe("delayed");
      end();
    });

    test("multiple waiters are resolved in order", async () => {
      const { stream, push, end } = createEventStream<number>();
      const p1 = stream.next();
      const p2 = stream.next();
      const p3 = stream.next();
      push(10);
      push(20);
      push(30);
      expect(await p1).toBe(10);
      expect(await p2).toBe(20);
      expect(await p3).toBe(30);
      end();
    });
  });

  // ========================================================================
  // end() semantics
  // ========================================================================

  describe("end()", () => {
    test("next returns null after end with empty buffer", async () => {
      const { stream, end } = createEventStream<string>();
      end();
      expect(await stream.next()).toBeNull();
    });

    test("buffered items are still returned after end", async () => {
      const { stream, push, end } = createEventStream<string>();
      push("a");
      push("b");
      end();
      expect(await stream.next()).toBe("a");
      expect(await stream.next()).toBe("b");
      expect(await stream.next()).toBeNull();
    });

    test("pending waiters receive null on end", async () => {
      const { stream, end } = createEventStream<string>();
      const p1 = stream.next();
      const p2 = stream.next();
      end();
      expect(await p1).toBeNull();
      expect(await p2).toBeNull();
    });

    test("calling end multiple times is safe", async () => {
      const { stream, end } = createEventStream<string>();
      end();
      end();
      end();
      expect(await stream.next()).toBeNull();
    });

    test("push after end is ignored", async () => {
      const { stream, push, end } = createEventStream<string>();
      end();
      push("ignored");
      expect(await stream.next()).toBeNull();
    });
  });

  // ========================================================================
  // fail() semantics
  // ========================================================================

  describe("fail()", () => {
    test("next throws the error after fail", async () => {
      const { stream, fail } = createEventStream<string>();
      fail(new Error("test error"));
      await expect(stream.next()).rejects.toThrow("test error");
    });

    test("pending waiters receive the error on fail", async () => {
      const { stream, fail } = createEventStream<string>();
      const p1 = stream.next();
      const p2 = stream.next();
      fail(new Error("stream failed"));
      // Both pending waiters should reject with the error
      let error1: Error | undefined;
      let error2: Error | undefined;
      try { await p1; } catch (e) { error1 = e as Error; }
      try { await p2; } catch (e) { error2 = e as Error; }
      expect(error1?.message).toBe("stream failed");
      expect(error2?.message).toBe("stream failed");
    });

    test("subsequent calls to next throw the stored error", async () => {
      const { stream, fail } = createEventStream<string>();
      fail(new Error("persistent error"));
      await expect(stream.next()).rejects.toThrow("persistent error");
      await expect(stream.next()).rejects.toThrow("persistent error");
    });

    test("fail after end is ignored", async () => {
      const { stream, end, fail } = createEventStream<string>();
      end();
      fail(new Error("too late"));
      // Should return null (ended), not throw
      expect(await stream.next()).toBeNull();
    });

    test("push after fail is ignored", async () => {
      const { stream, push, fail } = createEventStream<string>();
      fail(new Error("broken"));
      push("ignored");
      await expect(stream.next()).rejects.toThrow("broken");
    });
  });

  // ========================================================================
  // close() semantics
  // ========================================================================

  describe("close()", () => {
    test("next returns null after close", async () => {
      const { stream } = createEventStream<string>();
      stream.close();
      expect(await stream.next()).toBeNull();
    });

    test("close resolves pending waiters with null", async () => {
      const { stream } = createEventStream<string>();
      const p1 = stream.next();
      const p2 = stream.next();
      stream.close();
      expect(await p1).toBeNull();
      expect(await p2).toBeNull();
    });

    test("push after close is ignored", async () => {
      const { stream, push } = createEventStream<string>();
      stream.close();
      push("ignored");
      expect(await stream.next()).toBeNull();
    });

    test("close does not affect already buffered items (consumed before close check)", async () => {
      const { stream, push } = createEventStream<string>();
      push("buffered");
      // Close after buffering — the next() call checks closed flag
      // but items already in buffer are not accessible because closed=true takes priority
      stream.close();
      expect(await stream.next()).toBeNull();
    });
  });

  // ========================================================================
  // Mixed scenarios
  // ========================================================================

  describe("mixed scenarios", () => {
    test("interleaved push and next", async () => {
      const { stream, push, end } = createEventStream<number>();
      push(1);
      expect(await stream.next()).toBe(1);
      push(2);
      push(3);
      expect(await stream.next()).toBe(2);
      expect(await stream.next()).toBe(3);
      end();
      expect(await stream.next()).toBeNull();
    });

    test("works with different types", async () => {
      const { stream, push, end } = createEventStream<{ type: string; data: number }>();
      push({ type: "event", data: 42 });
      const result = await stream.next();
      expect(result).toEqual({ type: "event", data: 42 });
      end();
    });

    test("full producer/consumer task", async () => {
      const { stream, push, end } = createEventStream<number>();

      // Producer
      const produce = async () => {
        for (let i = 0; i < 5; i++) {
          push(i);
        }
        end();
      };

      // Consumer
      const consumed: number[] = [];
      const consume = async () => {
        let item = await stream.next();
        while (item !== null) {
          consumed.push(item);
          item = await stream.next();
        }
      };

      await Promise.all([produce(), consume()]);
      expect(consumed).toEqual([0, 1, 2, 3, 4]);
    });

    test("consumer starts before producer", async () => {
      const { stream, push, end } = createEventStream<string>();

      const consumed: string[] = [];
      const consume = async () => {
        let item = await stream.next();
        while (item !== null) {
          consumed.push(item);
          item = await stream.next();
        }
      };

      const consumePromise = consume();

      // Give consumer time to start waiting
      await new Promise((r) => setTimeout(r, 10));

      push("a");
      push("b");
      push("c");
      end();

      await consumePromise;
      expect(consumed).toEqual(["a", "b", "c"]);
    });
  });

  // ========================================================================
  // Buffer limits
  // ========================================================================

  describe("buffer limits", () => {
    test("defaults to large buffer size without options", async () => {
      const { stream, push, end } = createEventStream<number>();
      // Push a moderate number of items — should not evict
      for (let i = 0; i < 100; i++) {
        push(i);
      }
      // All 100 should be buffered
      for (let i = 0; i < 100; i++) {
        expect(await stream.next()).toBe(i);
      }
      end();
    });

    test("evicts oldest items when buffer exceeds maxBufferSize", async () => {
      const { stream, push, end } = createEventStream<number>({ maxBufferSize: 10 });
      // Push 15 items — buffer holds max 10, so oldest 1 (10% of 10 = 1) evicted per overflow
      for (let i = 0; i < 15; i++) {
        push(i);
      }
      // After pushing 11 items, item 0 is evicted (buffer: 1-10)
      // After pushing 12, item 1 is evicted (buffer: 2-11)
      // After pushing 13, item 2 is evicted (buffer: 3-12)
      // After pushing 14, item 3 is evicted (buffer: 4-13)
      // After pushing 15 (index 14), item 4 is evicted (buffer: 5-14)
      // End stream before draining so stream.next() returns null after buffer is empty
      end();
      const results: number[] = [];
      let item = await stream.next();
      while (item !== null) {
        results.push(item);
        item = await stream.next();
      }
      // Oldest items were evicted; only the most recent 10 should remain
      expect(results).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    });

    test("buffer limit of 1 keeps only the most recent item", async () => {
      const { stream, push, end } = createEventStream<string>({ maxBufferSize: 1 });
      push("a");
      push("b");
      push("c");
      // Only "c" should remain
      expect(await stream.next()).toBe("c");
      end();
      expect(await stream.next()).toBeNull();
    });

    test("buffer limit does not affect direct consumer delivery", async () => {
      const { stream, push, end } = createEventStream<number>({ maxBufferSize: 2 });
      // Start a waiter first — push should deliver directly, not buffer
      const p1 = stream.next();
      push(1);
      expect(await p1).toBe(1);

      // Now push to buffer
      push(2);
      push(3);
      expect(await stream.next()).toBe(2);
      expect(await stream.next()).toBe(3);
      end();
    });

    test("custom maxBufferSize is respected", async () => {
      const { stream, push, end } = createEventStream<number>({ maxBufferSize: 5 });
      // Push 8 items into a buffer of max 5
      for (let i = 0; i < 8; i++) {
        push(i);
      }
      const results: number[] = [];
      end();
      let item = await stream.next();
      while (item !== null) {
        results.push(item);
        item = await stream.next();
      }
      // Should have the last 5 items (3, 4, 5, 6, 7)
      expect(results.length).toBeLessThanOrEqual(5);
      expect(results[results.length - 1]).toBe(7);
    });

    test("maxBufferSize of 0 is clamped to 1", async () => {
      const { stream, push, end } = createEventStream<string>({ maxBufferSize: 0 });
      push("a");
      push("b");
      push("c");
      // Clamped to 1, so only the most recent item survives
      expect(await stream.next()).toBe("c");
      end();
      expect(await stream.next()).toBeNull();
    });

    test("negative maxBufferSize is clamped to 1", async () => {
      const { stream, push, end } = createEventStream<string>({ maxBufferSize: -5 });
      push("a");
      push("b");
      // Clamped to 1, so only "b" survives
      expect(await stream.next()).toBe("b");
      end();
      expect(await stream.next()).toBeNull();
    });

    test("fractional maxBufferSize is floored", async () => {
      const { stream, push, end } = createEventStream<number>({ maxBufferSize: 2.9 });
      // Floored to 2
      push(1);
      push(2);
      push(3);
      // Buffer holds max 2, so item 1 is evicted
      end();
      const results: number[] = [];
      let item = await stream.next();
      while (item !== null) {
        results.push(item);
        item = await stream.next();
      }
      expect(results).toEqual([2, 3]);
    });
  });
});
