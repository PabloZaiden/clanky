import { afterEach, expect, jest, test } from "bun:test";
import type { AgentEvent, PromptInput } from "../../src/backends/types";
import {
  AgentStreamController,
  type AgentStreamBackend,
} from "../../src/core/agent-stream-controller";
import { createEventStream, type EventStream } from "../../src/utils/event-stream";

afterEach(() => {
  jest.useRealTimers();
});

// The shared stream controller owns this cutoff for both chat and task turns; fake time verifies
// the exact boundary without waiting six real minutes.
test("ends a silent agent turn after the default 330-second inactivity window", async () => {
  jest.useFakeTimers();
  const source = createEventStream<AgentEvent>();
  let signalNextStarted!: () => void;
  const nextStarted = new Promise<void>((resolve) => {
    signalNextStarted = resolve;
  });
  let nextWasCalled = false;
  const stream: EventStream<AgentEvent> = {
    next() {
      if (!nextWasCalled) {
        nextWasCalled = true;
        signalNextStarted();
      }
      return source.stream.next();
    },
    close() {
      source.stream.close();
    },
  };
  const backend: AgentStreamBackend = {
    subscribeToEvents: async () => stream,
    sendPromptAsync: async () => {},
  };
  const handle = new AgentStreamController(backend).start({
    sessionId: "session",
    prompt: { parts: [] } satisfies PromptInput,
  });

  try {
    expect(await handle.startPrompt()).toBe(true);
    let inactivityHandled = false;
    let consumptionSettled = false;
    const consumption = handle.consume({
      onEvent: () => undefined,
      onInactivity: () => {
        inactivityHandled = true;
      },
    });
    void consumption.then(() => {
      consumptionSettled = true;
    });

    await nextStarted;
    jest.advanceTimersByTime(329_999);
    await Promise.resolve();
    expect(consumptionSettled).toBe(false);

    jest.advanceTimersByTime(1);
    await expect(consumption).resolves.toMatchObject({ endedByInactivity: true });
    expect(inactivityHandled).toBe(true);
  } finally {
    handle.close();
    jest.useRealTimers();
  }
});
