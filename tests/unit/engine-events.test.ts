import { describe, expect, test } from "bun:test";
import { persistLoopMessage, persistLoopToolCall } from "../../src/core/engine/engine-events";
import type { MessageData, ToolCallData } from "../../src/types/events";
import type { ToolCallExtra } from "../../src/types/tool-call";

const sampleAttachment = {
  id: "img-1",
  filename: "screen.png",
  mimeType: "image/png",
  data: "ZmFrZQ==",
  size: 1234,
};

const sampleToolExtra: ToolCallExtra = {
  id: "tool-extra-1",
  type: "image_preview",
  image: sampleAttachment,
  sourcePath: "/tmp/screen.png",
};

describe("persistLoopMessage", () => {
  test("retains image attachments when persisting a user message", () => {
    const message: MessageData = {
      id: "msg-1",
      role: "user",
      content: "Please inspect this screenshot",
      attachments: [sampleAttachment],
      timestamp: new Date().toISOString(),
    };

    const persisted = persistLoopMessage([], message);

    expect(persisted).toEqual([{
      id: "msg-1",
      role: "user",
      content: "Please inspect this screenshot",
      attachments: [sampleAttachment],
      timestamp: message.timestamp,
    }]);
  });

  test("preserves persisted attachments when updating a message without attachments", () => {
    const originalMessage: MessageData = {
      id: "msg-1",
      role: "user",
      content: "Please inspect this screenshot",
      attachments: [sampleAttachment],
      timestamp: new Date().toISOString(),
    };

    const updatedMessage: MessageData = {
      id: "msg-1",
      role: "user",
      content: "Please inspect this screenshot again",
      timestamp: new Date().toISOString(),
    };

    const persisted = persistLoopMessage([], originalMessage);
    const updatedPersisted = persistLoopMessage(persisted, updatedMessage);

    expect(updatedPersisted).toEqual([{
      id: "msg-1",
      role: "user",
      content: "Please inspect this screenshot again",
      attachments: [sampleAttachment],
      timestamp: updatedMessage.timestamp,
    }]);
  });
});

describe("persistLoopToolCall", () => {
  test("preserves persisted extras when a tool update omits them", () => {
    const originalToolCall: ToolCallData = {
      id: "tool-1",
      name: "read",
      input: { path: "/tmp/screen.png" },
      output: { content: "initial" },
      status: "completed",
      timestamp: "2025-01-01T00:00:00.000Z",
      extras: [sampleToolExtra],
    };
    const updatedToolCall: ToolCallData = {
      id: "tool-1",
      name: "read",
      input: { path: "/tmp/screen.png" },
      output: { content: "updated" },
      status: "completed",
      timestamp: "2025-01-01T00:00:01.000Z",
    };

    const persisted = persistLoopToolCall([], originalToolCall);
    const updatedPersisted = persistLoopToolCall(persisted, updatedToolCall);

    expect(updatedPersisted).toEqual([{
      ...updatedToolCall,
      extras: [sampleToolExtra],
    }]);
  });
});
