import { describe, expect, test } from "bun:test";
import { persistLoopMessage } from "../../src/core/engine/engine-events";
import type { MessageData } from "../../src/types/events";

const sampleAttachment = {
  id: "img-1",
  filename: "screen.png",
  mimeType: "image/png",
  data: "ZmFrZQ==",
  size: 1234,
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
