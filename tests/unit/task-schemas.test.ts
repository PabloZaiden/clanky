import { describe, expect, test } from "bun:test";

import {
  CreateTaskRequestSchema,
  FollowUpRequestSchema,
  GenerateTaskTitleRequestSchema,
  SetPendingRequestSchema,
  UpdateTaskRequestSchema,
} from "../../src/types/schemas/task";
import { MESSAGE_IMAGE_ATTACHMENT_LIMIT } from "../../src/types/message-attachments";
import { DEFAULT_TASK_CONFIG } from "../../src/types/task";

const baseCreateTaskRequest = {
  
  cheapModel: { mode: "same-as-task" as const },
  maxIterations: null,
  maxConsecutiveErrors: DEFAULT_TASK_CONFIG.maxConsecutiveErrors,
  activityTimeoutSeconds: DEFAULT_TASK_CONFIG.activityTimeoutSeconds,
  stopPattern: DEFAULT_TASK_CONFIG.stopPattern,
  git: {
    branchPrefix: DEFAULT_TASK_CONFIG.git.branchPrefix,
    commitScope: DEFAULT_TASK_CONFIG.git.commitScope,
  },
  baseBranch: "main",
  clearPlanningFolder: false,
  autoAcceptPlan: false,
  fullyAutonomous: false,
  draft: false,
};

describe("task attachment schemas", () => {
  test("accepts unlimited activity timeout on create-task requests", () => {
    expect(CreateTaskRequestSchema.safeParse({
      name: "Unlimited timeout task",
      workspaceId: "ws-1",
      prompt: "Do a task",
      attachments: [],
      model: {
        providerID: "provider",
        modelID: "model",
        variant: "",
      },
      ...baseCreateTaskRequest,
      activityTimeoutSeconds: null,
      useWorktree: true,
      planMode: false,
    }).success).toBe(true);

    const { activityTimeoutSeconds: _activityTimeoutSeconds, ...requestWithoutTimeout } = baseCreateTaskRequest;
    expect(CreateTaskRequestSchema.safeParse({
      name: "Default timeout task",
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

  test("accepts clearing max iterations on update-task requests", () => {
    expect(UpdateTaskRequestSchema.safeParse({
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
    expect(CreateTaskRequestSchema.safeParse({
      name: "Too short timeout",
      workspaceId: "ws-1",
      prompt: "Do a task",
      attachments: [],
      model: {
        providerID: "provider",
        modelID: "model",
        variant: "",
      },
      ...baseCreateTaskRequest,
      activityTimeoutSeconds: 59,
      useWorktree: true,
      planMode: false,
    }).success).toBe(false);
  });

  test("accepts transient image attachments on create-task requests", () => {
    const result = CreateTaskRequestSchema.safeParse({
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
      ...baseCreateTaskRequest,
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

    expect(CreateTaskRequestSchema.safeParse({
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
      ...baseCreateTaskRequest,
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
    expect(CreateTaskRequestSchema.safeParse({
      name: "Cheap helper model task",
      workspaceId: "ws-1",
      prompt: "Do a task",
      attachments: [],
      model: {
        providerID: "provider",
        modelID: "main-model",
        variant: "",
      },
      ...baseCreateTaskRequest,
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

    expect(GenerateTaskTitleRequestSchema.safeParse({
      workspaceId: "ws-1",
      prompt: "Create a useful title",
        model: {
          providerID: "provider",
          modelID: "main-model",
          variant: "",
        },
      cheapModel: {
        mode: "same-as-task",
      },
    }).success).toBe(true);
  });
});
