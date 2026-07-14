import { describe, expect, test } from "bun:test";
import { SessionStateStore } from "../../src/backends/acp/session-state";
import { CapabilityService } from "../../src/backends/acp/capability-service";
import { AcpEventTranslator } from "../../src/backends/acp/event-translator";
import type { AgentEvent } from "../../src/backends/types";
import type { JsonRpcMessage } from "../../src/backends/acp/types";
import type { RpcRequester } from "../../src/backends/acp/contracts";

function setup(): {
  state: SessionStateStore;
  translator: AcpEventTranslator;
  events: AgentEvent[];
} {
  const state = new SessionStateStore();
  const requester: RpcRequester = {
    async sendRequest<T>(): Promise<T> {
      return undefined as T;
    },
    writeMessage(_message: JsonRpcMessage): void {},
  };
  const capability = new CapabilityService(requester);
  const translator = new AcpEventTranslator(state, capability);
  const events: AgentEvent[] = [];
  state.addSessionSubscriber("s1", (event) => events.push(event));
  return { state, translator, events };
}

describe("AcpEventTranslator", () => {
  test("emits message.start then message.delta for assistant chunks", () => {
    const { state, translator, events } = setup();
    state.beginPrompt("s1");

    translator.handleSessionUpdate({
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { text: "Hello" } },
    });

    expect(events[0]!.type).toBe("message.start");
    expect(events[1]).toMatchObject({ type: "message.delta", content: "Hello" });
  });

  test("normalizes snapshot chunks into incremental deltas", () => {
    const { state, translator, events } = setup();
    state.beginPrompt("s1");

    translator.handleSessionUpdate({
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { text: "Hello" } },
    });
    translator.handleSessionUpdate({
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { text: "Hello world" } },
    });

    const deltas = events.filter((e) => e.type === "message.delta");
    expect(deltas).toEqual([
      { type: "message.delta", content: "Hello" },
      { type: "message.delta", content: " world" },
    ]);
  });

  test("suppresses duplicate reasoning chunks with the same signature", () => {
    const { state, translator, events } = setup();
    state.beginPrompt("s1");

    const update = {
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        partId: "r1",
        content: { text: "thinking" },
      },
    };
    translator.handleSessionUpdate(update);
    translator.handleSessionUpdate(update);

    const reasoning = events.filter((e) => e.type === "reasoning.delta");
    expect(reasoning).toEqual([{ type: "reasoning.delta", content: "thinking" }]);
  });

  test("emits tool.start then tool.complete across the tool lifecycle", () => {
    const { state, translator, events } = setup();
    state.beginPrompt("s1");

    translator.handleSessionUpdate({
      sessionId: "s1",
      update: { sessionUpdate: "tool_call", toolCallId: "t1", content: { toolName: "bash", input: { cmd: "ls" } } },
    });
    translator.handleSessionUpdate({
      sessionId: "s1",
      update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: { output: "ok" } },
    });

    expect(events).toEqual([
      { type: "tool.start", toolCallId: "t1", toolName: "bash", input: { cmd: "ls" } },
      { type: "tool.complete", toolCallId: "t1", toolName: "bash", input: undefined, output: "ok" },
    ]);
  });

  test("completes the message on idle status once the prompt produced activity", () => {
    const { state, translator, events } = setup();
    state.beginPrompt("s1");

    translator.handleSessionUpdate({
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { text: "done" } },
    });
    translator.handleSessionStatus({ sessionId: "s1", status: "idle" });

    const complete = events.find((e) => e.type === "message.complete");
    expect(complete).toEqual({ type: "message.complete", content: "" });
    expect(state.hasActivePrompt("s1")).toBe(false);
  });

  test("emits active prompt errors before connection state is cleared", () => {
    const { state, events } = setup();
    state.beginPrompt("s1");

    state.emitActivePromptError({
      message: "ACP process exited",
      code: "acp_process_failed",
    });

    expect(events).toContainEqual({
      type: "error",
      message: "ACP process exited",
      code: "acp_process_failed",
    });
    expect(state.hasActivePrompt("s1")).toBe(true);
  });

  test("does not deliver events for a different session", () => {
    const { translator, events } = setup();

    translator.handleSessionUpdate({
      sessionId: "other",
      update: { sessionUpdate: "agent_message_chunk", content: { text: "nope" } },
    });

    expect(events).toHaveLength(0);
  });
});
