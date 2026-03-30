import { describe, expect, test } from "bun:test";

import {
  AnswerPlanQuestionRequestSchema,
  CreateLoopRequestSchema,
  SetPendingRequestSchema,
} from "../../src/types/schemas/loop";

describe("AnswerPlanQuestionRequestSchema", () => {
  test("accepts non-empty answers and trims surrounding whitespace", () => {
    const result = AnswerPlanQuestionRequestSchema.safeParse({
      answers: [["  Option B  "], [" custom answer "]],
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.answers).toEqual([["Option B"], ["custom answer"]]);
  });

  test("rejects empty answer groups, blank strings, and missing groups", () => {
    expect(AnswerPlanQuestionRequestSchema.safeParse({
      answers: [["valid"], []],
    }).success).toBe(false);

    expect(AnswerPlanQuestionRequestSchema.safeParse({
      answers: [["   "]],
    }).success).toBe(false);

    expect(AnswerPlanQuestionRequestSchema.safeParse({
      answers: [],
    }).success).toBe(false);
  });
});

describe("loop attachment schemas", () => {
  test("accepts transient image attachments on create-loop requests", () => {
    const result = CreateLoopRequestSchema.safeParse({
      name: "Screenshot review",
      workspaceId: "ws-1",
      prompt: "Look at this screenshot",
      attachments: [{
        id: "img-1",
        filename: "screen.png",
        mimeType: "image/png",
        data: "ZmFrZQ==",
        size: 1024,
      }],
      model: {
        providerID: "provider",
        modelID: "model",
      },
      useWorktree: true,
      planMode: false,
    });

    expect(result.success).toBe(true);
  });

  test("rejects non-image attachments and oversized attachment batches", () => {
    expect(CreateLoopRequestSchema.safeParse({
      name: "Invalid attachment",
      workspaceId: "ws-1",
      prompt: "Invalid attachment",
      attachments: [{
        id: "bad-1",
        filename: "notes.txt",
        mimeType: "text/plain",
        data: "ZmFrZQ==",
        size: 10,
      }],
      model: {
        providerID: "provider",
        modelID: "model",
      },
      useWorktree: true,
      planMode: false,
    }).success).toBe(false);

    expect(SetPendingRequestSchema.safeParse({
      message: "Too many images",
      attachments: [
        { id: "1", filename: "a.png", mimeType: "image/png", data: "x", size: 1 },
        { id: "2", filename: "b.png", mimeType: "image/png", data: "x", size: 1 },
        { id: "3", filename: "c.png", mimeType: "image/png", data: "x", size: 1 },
        { id: "4", filename: "d.png", mimeType: "image/png", data: "x", size: 1 },
      ],
    }).success).toBe(false);
  });
});
