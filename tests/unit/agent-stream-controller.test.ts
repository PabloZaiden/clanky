import { describe, expect, test } from "bun:test";
import type { AgentEvent, PromptInput } from "../../src/backends/types";
import { AgentStreamController } from "../../src/core/agent-stream-controller";
import { createEventStream, type EventStream } from "../../src/utils/event-stream";

function createBackend(events: AgentEvent[], calls: string[]): {
  subscribeToEvents: (sessionId: string) => Promise<EventStream<AgentEvent>>;
  sendPromptAsync: (sessionId: string, prompt: PromptInput) => Promise<void>;
} {
  let stream: ReturnType<typeof createEventStream<AgentEvent>> | undefined;

  return {
    async subscribeToEvents(): Promise<EventStream<AgentEvent>> {
      calls.push("subscribe");
      stream = createEventStream<AgentEvent>();
      for (const event of events) {
        stream.push(event);
      }
      stream.end();
      return stream.stream;
    },
    async sendPromptAsync(): Promise<void> {
      calls.push("send");
    },
  };
}

describe("AgentStreamController", () => {
  test("subscribes before sending and consumes one complete turn", async () => {
    const calls: string[] = [];
    const events: AgentEvent[] = [
      { type: "message.start", messageId: "message-1" },
      { type: "message.delta", content: "hello" },
      { type: "message.complete", content: "hello" },
    ];
    const seen: string[] = [];
    const controller = new AgentStreamController(createBackend(events, calls));

    const handle = controller.start({
      sessionId: "session-1",
      prompt: { parts: [{ type: "text", text: "prompt" }] },
      activityTimeoutMs: null,
    });
    await expect(handle.startPrompt()).resolves.toBe(true);
    const result = await handle.consume({
      onEvent: async (event) => {
        seen.push(event.type);
      },
    });

    expect(calls).toEqual(["subscribe", "send"]);
    expect(seen).toEqual(["message.start", "message.delta", "message.complete"]);
    expect(result.lastEvent?.type).toBe("message.complete");
    expect(result.stopped).toBe(true);
  });

  test("allows a domain adapter to stop before the next event", async () => {
    const calls: string[] = [];
    const events: AgentEvent[] = [
      { type: "message.start", messageId: "message-1" },
      { type: "message.delta", content: "cancelled" },
      { type: "message.complete", content: "cancelled" },
    ];
    const seen: string[] = [];
    const controller = new AgentStreamController(createBackend(events, calls));

    const handle = controller.start({
      sessionId: "session-1",
      prompt: { parts: [{ type: "text", text: "prompt" }] },
      activityTimeoutMs: null,
    });
    await expect(handle.startPrompt()).resolves.toBe(true);
    const result = await handle.consume({
      onEvent: async (event) => {
        seen.push(event.type);
        return { stop: event.type === "message.start" };
      },
    });

    expect(seen).toEqual(["message.start"]);
    expect(result.lastEvent?.type).toBe("message.start");
    expect(result.stopped).toBe(true);
  });

  test("does not send a prompt after startup is cancelled", async () => {
    const calls: string[] = [];
    const controller = new AgentStreamController(createBackend([], calls));

    const handle = controller.start({
      sessionId: "session-1",
      prompt: { parts: [{ type: "text", text: "prompt" }] },
      activityTimeoutMs: null,
    });
    const startPromise = handle.startPrompt();
    handle.close();

    await expect(startPromise).resolves.toBe(false);
    const result = await handle.consume({
      onEvent: async () => {},
    });

    expect(calls).toEqual(["subscribe"]);
    expect(result).toEqual({ lastEvent: null, stopped: true });
  });

  test("propagates startup failures and closes a subscribed stream", async () => {
    const startupError = new Error("prompt failed");
    const subscription = { stream: null as EventStream<AgentEvent> | null };
    const controller = new AgentStreamController({
      async subscribeToEvents(): Promise<EventStream<AgentEvent>> {
        const created = createEventStream<AgentEvent>();
        subscription.stream = created.stream;
        return created.stream;
      },
      async sendPromptAsync(): Promise<void> {
        throw startupError;
      },
    });

    const handle = controller.start({
      sessionId: "session-1",
      prompt: { parts: [{ type: "text", text: "prompt" }] },
      activityTimeoutMs: null,
    });

    await expect(handle.startPrompt()).rejects.toBe(startupError);
    expect(subscription.stream).not.toBeNull();
    const stream = subscription.stream;
    if (!stream) {
      throw new Error("Expected the backend stream to be subscribed");
    }
    await expect(stream.next()).resolves.toBeNull();
  });
});
