import { describe, expect, test } from "bun:test";

import {
  CreateLoopRequestSchema,
  FollowUpRequestSchema,
  GenerateLoopTitleRequestSchema,
  SetPendingRequestSchema,
  UpdateLoopRequestSchema,
} from "../../src/types/schemas/loop";
import { MESSAGE_IMAGE_ATTACHMENT_LIMIT } from "../../src/types/message-attachments";
import { DEFAULT_LOOP_CONFIG } from "../../src/types/loop";

const baseCreateLoopRequest = {
  
  cheapModel: { mode: "same-as-loop" as const },
  maxIterations: null,
  maxConsecutiveErrors: DEFAULT_LOOP_CONFIG.maxConsecutiveErrors,
  activityTimeoutSeconds: DEFAULT_LOOP_CONFIG.activityTimeoutSeconds,
  stopPattern: DEFAULT_LOOP_CONFIG.stopPattern,
  git: {
    branchPrefix: DEFAULT_LOOP_CONFIG.git.branchPrefix,
    commitScope: DEFAULT_LOOP_CONFIG.git.commitScope,
  },
  baseBranch: "main",
  clearPlanningFolder: false,
  autoAcceptPlan: false,
  fullyAutonomous: false,
  draft: false,
};

describe("loop attachment schemas", () => {
  test("accepts unlimited activity timeout on create-loop requests", () => {
    expect(CreateLoopRequestSchema.safeParse({
      name: "Unlimited timeout loop",
      workspaceId: "ws-1",
      prompt: "Do a task",
      attachments: [],
      model: {
        providerID: "provider",
        modelID: "model",
        variant: "",
      },
      ...baseCreateLoopRequest,
      activityTimeoutSeconds: null,
      useWorktree: true,
      planMode: false,
    }).success).toBe(true);

    const { activityTimeoutSeconds: _activityTimeoutSeconds, ...requestWithoutTimeout } = baseCreateLoopRequest;
    expect(CreateLoopRequestSchema.safeParse({
      name: "Default timeout loop",
      workspaceId: "ws-1",
      prompt: "Do a task",
      attachments: [],
      model: {
        providerID: "provider",
        modelID: "model",
        variant: "",
      },
      ...requestWithoutTimeout,
      useWorktree: true,
      planMode: false,
    }).success).toBe(true);
  });

  test("accepts clearing max iterations on update-loop requests", () => {
    expect(UpdateLoopRequestSchema.safeParse({
      maxIterations: null,
    }).success).toBe(true);
  });

  test("validates optional follow-up prompt mode", () => {
    expect(FollowUpRequestSchema.safeParse({
      message: "Continue",
      model: null,
      attachments: [],
    }).success).toBe(true);

    expect(FollowUpRequestSchema.safeParse({
      message: "Continue",
      model: null,
      attachments: [],
      promptMode: "plain_chat",
    }).success).toBe(true);

    expect(FollowUpRequestSchema.safeParse({
      message: "Continue",
      model: null,
      attachments: [],
      promptMode: "unknown",
    }).success).toBe(false);
  });

  test("rejects finite activity timeout values below the minimum", () => {
    expect(CreateLoopRequestSchema.safeParse({
      name: "Too short timeout",
      workspaceId: "ws-1",
      prompt: "Do a task",
      attachments: [],
      model: {
        providerID: "provider",
        modelID: "model",
        variant: "",
      },
      ...baseCreateLoopRequest,
      activityTimeoutSeconds: 59,
      useWorktree: true,
      planMode: false,
    }).success).toBe(false);
  });

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
        variant: "",
      },
      ...baseCreateLoopRequest,
      useWorktree: true,
      planMode: false,
    });

    expect(result.success).toBe(true);
  });

  test("rejects non-image attachments and oversized attachment batches", () => {
    const oversizedAttachmentBatch = Array.from(
      { length: MESSAGE_IMAGE_ATTACHMENT_LIMIT + 1 },
      (_value, index) => ({
        id: String(index + 1),
        filename: `${index + 1}.png`,
        mimeType: "image/png",
        data: "x",
        size: 1,
      }),
    );

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
        variant: "",
      },
      ...baseCreateLoopRequest,
      useWorktree: true,
      planMode: false,
    }).success).toBe(false);

    expect(SetPendingRequestSchema.safeParse({
      message: "Too many images",
      attachments: oversizedAttachmentBatch,
      model: null,
      immediate: true,
    }).success).toBe(false);
  });

  test("accepts cheap model selections on create and title-generation requests", () => {
    expect(CreateLoopRequestSchema.safeParse({
      name: "Cheap helper model loop",
      workspaceId: "ws-1",
      prompt: "Do a task",
      attachments: [],
      model: {
        providerID: "provider",
        modelID: "main-model",
        variant: "",
      },
      ...baseCreateLoopRequest,
      cheapModel: {
        mode: "custom",
        model: {
          providerID: "provider",
          modelID: "cheap-model",
          variant: "fast",
        },
      },
      useWorktree: true,
      planMode: false,
    }).success).toBe(true);

    expect(GenerateLoopTitleRequestSchema.safeParse({
      workspaceId: "ws-1",
      prompt: "Create a useful title",
        model: {
          providerID: "provider",
          modelID: "main-model",
          variant: "",
        },
      cheapModel: {
        mode: "same-as-loop",
      },
    }).success).toBe(true);
  });
});
