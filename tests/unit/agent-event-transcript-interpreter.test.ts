import { describe, expect, test } from "bun:test";
import {
  AgentEventTranscriptInterpreter,
} from "../../src/core/agent-event-transcript-interpreter";

function createInterpreter() {
  let timestamp = 0;
  return new AgentEventTranscriptInterpreter({
    createTimestamp: () => `2026-08-07T00:00:0${timestamp++}.000Z`,
    idFactories: {
      createResponseMessageId: (state) =>
        state.currentMessageId ?? `response-${state.responseSegmentCount + 1}`,
      createResponseLogId: (kind, state) =>
        `${kind}-log-${state.responseSegmentCount + 1}`,
      createToolCallId: (event) =>
        event.toolCallId ?? `generated-tool-${timestamp}`,
    },
  });
}

describe("AgentEventTranscriptInterpreter", () => {
  test("projects response and reasoning blocks and finalizes the assistant message", () => {
    const interpreter = createInterpreter();

    interpreter.handle({ type: "message.start", messageId: "message-1" });
    const response = interpreter.handle({ type: "message.delta", content: "hello" });
    const reasoning = interpreter.handle({ type: "reasoning.delta", content: "checking" });
    const resumedResponse = interpreter.handle({ type: "message.delta", content: " world" });
    const completed = interpreter.handle({
      type: "message.complete",
      content: "hello world",
    });

    expect(response.responseDelta).toMatchObject({
      kind: "response",
      delta: "hello",
      content: "hello",
      messageId: "message-1",
      isFirstInBlock: true,
    });
    expect(reasoning.flushedBlocks).toEqual([
      expect.objectContaining({
        kind: "response",
        content: "hello",
        messageId: "message-1",
      }),
    ]);
    expect(resumedResponse.flushedBlocks).toEqual([
      expect.objectContaining({
        kind: "reasoning",
        content: "checking",
      }),
    ]);
    expect(completed.completedMessage).toMatchObject({
      message: {
        id: "message-1",
        role: "assistant",
        content: "hello world",
      },
      responseLength: 11,
      hadResponseBlock: true,
    });
    expect(completed.flushedBlocks).toEqual([
      expect.objectContaining({
        kind: "response",
        content: "hello world",
      }),
    ]);
  });

  test("creates a final response projection when completion has no preceding delta", () => {
    const interpreter = createInterpreter();

    interpreter.handle({ type: "message.start", messageId: "message-2" });
    const completed = interpreter.handle({
      type: "message.complete",
      content: "complete without delta",
    });

    expect(completed.completedMessage?.message).toMatchObject({
      id: "message-2",
      content: "complete without delta",
    });
    expect(completed.completedMessage?.hadResponseBlock).toBe(false);
    expect(completed.flushedBlocks).toEqual([
      expect.objectContaining({
        kind: "response",
        content: "complete without delta",
        messageId: "message-2",
      }),
    ]);
  });

  test("matches tool completion by ID or latest running name and preserves start input", () => {
    const interpreter = createInterpreter();

    const firstStart = interpreter.handle({
      type: "tool.start",
      toolCallId: "tool-1",
      toolName: "read",
      input: { path: "first" },
    });
    const secondStart = interpreter.handle({
      type: "tool.start",
      toolCallId: "tool-2",
      toolName: "read",
      input: { path: "second" },
    });
    const nameMatched = interpreter.handle({
      type: "tool.complete",
      toolName: "read",
      output: "second output",
    });
    const idMatched = interpreter.handle({
      type: "tool.complete",
      toolCallId: "tool-1",
      toolName: "read",
      output: "first output",
    });

    expect(firstStart.tool?.tool).toMatchObject({
      id: "tool-1",
      status: "running",
      input: { path: "first" },
    });
    expect(secondStart.tool?.tool).toMatchObject({
      id: "tool-2",
      status: "running",
      input: { path: "second" },
    });
    expect(nameMatched.tool?.tool).toMatchObject({
      id: "tool-2",
      status: "completed",
      input: { path: "second" },
      output: "second output",
    });
    expect(idMatched.tool?.tool).toMatchObject({
      id: "tool-1",
      status: "completed",
      input: { path: "first" },
      output: "first output",
    });
  });

  test("clears cancelled tools from the name fallback index", () => {
    const interpreter = createInterpreter();

    interpreter.handle({
      type: "tool.start",
      toolCallId: "tool-cancelled",
      toolName: "read",
      input: { path: "README.md" },
    });

    const cancelled = interpreter.cancelRunningTools("2026-08-07T00:01:00.000Z");
    expect(cancelled).toEqual([
      expect.objectContaining({
        id: "tool-cancelled",
        status: "failed",
        output: "Cancelled by user.",
      }),
    ]);

    const lateCompletion = interpreter.handle({
      type: "tool.complete",
      toolName: "read",
      output: "late result",
    });
    expect(lateCompletion.tool?.tool.id).not.toBe("tool-cancelled");
    expect(interpreter.state.toolCalls.get("tool-cancelled")?.status).toBe("failed");
  });
});
