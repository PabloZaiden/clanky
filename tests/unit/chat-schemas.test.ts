import { describe, expect, test } from "bun:test";

import { DEFAULT_CHAT_INTERRUPT_REASON } from "../../src/types/chat";
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

  test("accepts omitted and blank chat names for generated titles", () => {
    const basePayload = {
      workspaceId: "ws-1",
      model: {
        providerID: "copilot",
        modelID: "gpt-5.4",
        variant: "",
      },
      useWorktree: true,
      baseBranch: "main",
    };

    expect(CreateChatRequestSchema.safeParse(basePayload).success).toBe(true);

    const blankName = CreateChatRequestSchema.safeParse({
      ...basePayload,
      name: "   ",
    });
    expect(blankName.success).toBe(true);
    if (!blankName.success) {
      return;
    }
    expect(blankName.data.name).toBe("");
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
  test("defaults a missing reason and trims explicit values", () => {
    const defaulted = InterruptChatRequestSchema.safeParse({});
    expect(defaulted.success).toBe(true);
    if (!defaulted.success) {
      return;
    }
    expect(defaulted.data.reason).toBe(DEFAULT_CHAT_INTERRUPT_REASON);

    expect(InterruptChatRequestSchema.safeParse({ reason: "   " }).success).toBe(false);
    const result = InterruptChatRequestSchema.safeParse({
      reason: ` ${DEFAULT_CHAT_INTERRUPT_REASON} `,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.reason).toBe(DEFAULT_CHAT_INTERRUPT_REASON);
  });
});
