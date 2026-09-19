import { describe, expect, test } from "bun:test";
import {
  AgentStreamController,
  type AgentStreamBackend,
} from "../../src/core/agent-stream-controller";
import type { AgentEvent } from "../../src/backends/types";
import { createEventStream, type EventStream } from "../../src/utils/event-stream";

function createBackend(stream: EventStream<AgentEvent>): AgentStreamBackend {
  return {
    subscribeToEvents: async () => stream,
    sendPromptAsync: async () => {},
  };
}

describe("AgentStreamController inactivity", () => {
  test("resolves an inactive stream as normal completion and closes it", async () => {
    const source = createEventStream<AgentEvent>();
    const lastEvent: AgentEvent = { type: "message.start", messageId: "message-1" };
    source.push(lastEvent);
    let closed = false;
    const stream: EventStream<AgentEvent> = {
      next: () => source.stream.next(),
      close: () => {
        closed = true;
        source.stream.close();
      },
    };
    const handle = new AgentStreamController(createBackend(stream)).start({
      sessionId: "session-1",
      prompt: { parts: [{ type: "text", text: "hello" }] },
      activityTimeoutMs: 1,
    });

    await handle.startPrompt();
    const result = await handle.consume({
      onEvent: () => {},
    });

    expect(result).toEqual({
      lastEvent,
      stopped: true,
      endedByInactivity: true,
    });
    expect(closed).toBe(true);
  });

  test("does not normalize stream failures as inactivity", async () => {
    const source = createEventStream<AgentEvent>();
    const stream: EventStream<AgentEvent> = {
      next: () => source.stream.next(),
      close: () => source.stream.close(),
    };
    const handle = new AgentStreamController(createBackend(stream)).start({
      sessionId: "session-1",
      prompt: { parts: [{ type: "text", text: "hello" }] },
      activityTimeoutMs: 1_000,
    });

    await handle.startPrompt();
    source.fail(new Error("transport failed"));

    await expect(handle.consume({ onEvent: () => {} })).rejects.toBeInstanceOf(Error);
  });

  test("runs the inactivity cleanup before returning", async () => {
    const source = createEventStream<AgentEvent>();
    const stream: EventStream<AgentEvent> = {
      next: () => source.stream.next(),
      close: () => source.stream.close(),
    };
    let cleanupCalls = 0;
    const handle = new AgentStreamController(createBackend(stream)).start({
      sessionId: "session-1",
      prompt: { parts: [{ type: "text", text: "hello" }] },
      activityTimeoutMs: 1,
    });

    await handle.startPrompt();
    await handle.consume({
      onEvent: () => {},
      onInactivity: () => {
        cleanupCalls += 1;
      },
    });

    expect(cleanupCalls).toBe(1);
  });
});
