import { describe, expect, test } from "bun:test";
import {
  createProcessStdoutStream,
  type StreamedProcess,
} from "../../src/core/remote-executor/executor";

describe("remote executor process streams", () => {
  test("closes the outer stream when cancellation races an underlying EOF", async () => {
    const payload = new TextEncoder().encode("payload");
    let resolveExited: ((exitCode: number) => void) | undefined;
    let killed = false;
    const process: StreamedProcess = {
      stdout: new ReadableStream<Uint8Array>({
        start(controller: ReadableStreamDefaultController<Uint8Array>) {
          controller.enqueue(payload);
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller: ReadableStreamDefaultController<Uint8Array>) {
          controller.close();
        },
      }),
      exited: new Promise<number>((resolve) => {
        resolveExited = resolve;
      }),
      kill() {
        killed = true;
        resolveExited?.(0);
      },
    };
    const abortController = new AbortController();
    const stream = createProcessStdoutStream(
      process,
      "test process stream",
      abortController.signal,
    );
    const reader = stream.getReader();

    const firstRead = await reader.read();
    expect(firstRead.done).toBe(false);
    expect(firstRead.value).toEqual(payload);

    abortController.abort();

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const secondRead = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error("Cancelled process stream did not close"));
          }, 1_000);
        }),
      ]);
      expect(secondRead.done).toBe(true);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
    expect(killed).toBe(true);
  });
});
