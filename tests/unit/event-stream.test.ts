import { describe, expect, test } from "bun:test";
import { createEventStream } from "../../src/utils/event-stream";

describe("createEventStream", () => {
  test("drains buffered items before returning null after normal end", async () => {
    const { stream, push, end } = createEventStream<number>({ maxBufferSize: 3 });
    push(1);
    push(2);
    end();
    push(3);

    await expect(stream.next()).resolves.toBe(1);
    await expect(stream.next()).resolves.toBe(2);
    await expect(stream.next()).resolves.toBeNull();
    await expect(stream.next()).resolves.toBeNull();
  });

  test("resolves all pending readers when the stream ends", async () => {
    const { stream, end } = createEventStream<number>();
    const pendingReads = [stream.next(), stream.next()];

    end();

    await expect(Promise.all(pendingReads)).resolves.toEqual([null, null]);
  });

  test("resolves pending and future reads as null when closed", async () => {
    const { stream, push, end, fail } = createEventStream<number>();
    const pendingRead = stream.next();
    const failure = new Error("late failure");

    stream.close();
    stream.close();
    push(1);
    end();
    fail(failure);

    await expect(pendingRead).resolves.toBeNull();
    await expect(stream.next()).resolves.toBeNull();
  });

  test("keeps the first normal end when later terminals are attempted", async () => {
    const { stream, push, end, fail } = createEventStream<number>();
    const failure = new Error("late failure");

    push(1);
    end();
    end();
    fail(failure);
    stream.close();
    push(2);

    await expect(stream.next()).resolves.toBe(1);
    await expect(stream.next()).resolves.toBeNull();
    await expect(stream.next()).resolves.toBeNull();
  });

  test("keeps the first failure for pending and future reads", async () => {
    const { stream, push, end, fail } = createEventStream<number>();
    const pendingRead = stream.next();
    const failure = new Error("transport failed");

    fail(failure);
    end();
    stream.close();
    push(1);

    await expect(pendingRead).rejects.toBe(failure);
    await expect(stream.next()).rejects.toBe(failure);
  });

  test("evicts the oldest buffered item when the buffer is full", async () => {
    const { stream, push, end } = createEventStream<number>({ maxBufferSize: 3 });
    push(1);
    push(2);
    push(3);
    push(4);
    end();

    await expect(stream.next()).resolves.toBe(2);
    await expect(stream.next()).resolves.toBe(3);
    await expect(stream.next()).resolves.toBe(4);
    await expect(stream.next()).resolves.toBeNull();
  });
});
