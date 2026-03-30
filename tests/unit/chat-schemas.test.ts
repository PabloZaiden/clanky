import { describe, expect, test } from "bun:test";

import {
  CreateChatRequestSchema,
  InterruptChatRequestSchema,
  SendChatMessageRequestSchema,
} from "../../src/types/schemas/chat";

describe("CreateChatRequestSchema", () => {
  test("accepts a valid chat creation payload", () => {
    const result = CreateChatRequestSchema.safeParse({
      name: "Feature implementation chat",
      workspaceId: "ws-1",
      model: {
        providerID: "copilot",
        modelID: "gpt-5.4",
      },
      useWorktree: true,
      baseBranch: "main",
    });

    expect(result.success).toBe(true);
  });
});

describe("SendChatMessageRequestSchema", () => {
  test("accepts text-only and attachment-only messages", () => {
    expect(SendChatMessageRequestSchema.safeParse({
      message: "Please inspect this image",
    }).success).toBe(true);

    expect(SendChatMessageRequestSchema.safeParse({
      attachments: [{
        id: "img-1",
        filename: "screen.png",
        mimeType: "image/png",
        data: "ZmFrZQ==",
        size: 1024,
      }],
    }).success).toBe(true);
  });

  test("rejects empty messages without attachments", () => {
    expect(SendChatMessageRequestSchema.safeParse({
      message: "   ",
    }).success).toBe(false);
  });
});

describe("InterruptChatRequestSchema", () => {
  test("accepts an empty body or a trimmed reason", () => {
    expect(InterruptChatRequestSchema.safeParse({}).success).toBe(true);

    const result = InterruptChatRequestSchema.safeParse({
      reason: " user requested stop ",
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.reason).toBe("user requested stop");
  });
});
