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
        variant: "",
      },
      useWorktree: true,
      baseBranch: "main",
    });

    expect(result.success).toBe(true);
  });
});

describe("SendChatMessageRequestSchema", () => {
  test("normalizes omitted fields for text-only and attachment-only messages", () => {
    const textOnly = SendChatMessageRequestSchema.safeParse({
      message: "Please inspect this image",
    });
    expect(textOnly.success).toBe(true);
    if (!textOnly.success) {
      return;
    }
    expect(textOnly.data).toEqual({
      message: "Please inspect this image",
      attachments: [],
    });

    const attachmentOnly = SendChatMessageRequestSchema.safeParse({
      attachments: [{
        id: "img-1",
        filename: "screen.png",
        mimeType: "image/png",
        data: "ZmFrZQ==",
        size: 1024,
      }],
    });
    expect(attachmentOnly.success).toBe(true);
    if (!attachmentOnly.success) {
      return;
    }
    expect(attachmentOnly.data).toEqual({
      message: null,
      attachments: [{
        id: "img-1",
        filename: "screen.png",
        mimeType: "image/png",
        data: "ZmFrZQ==",
        size: 1024,
      }],
    });
  });

  test("rejects empty messages without attachments", () => {
    expect(SendChatMessageRequestSchema.safeParse({
      message: "   ",
      attachments: [],
    }).success).toBe(false);
  });
});

describe("InterruptChatRequestSchema", () => {
  test("requires an explicit reason field and trims it", () => {
    expect(InterruptChatRequestSchema.safeParse({}).success).toBe(false);
    expect(InterruptChatRequestSchema.safeParse({ reason: "   " }).success).toBe(false);
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
