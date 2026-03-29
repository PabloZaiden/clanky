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
});
