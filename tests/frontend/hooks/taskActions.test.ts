/**
 * Tests for taskActions API functions.
 *
 * These are pure async functions that call fetch() and return results or throw errors.
 * Each function is tested for success and error responses.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createMockApi, MockApiError } from "../helpers/mock-api";
import {
  acceptTaskApi,
  pushTaskApi,
  discardTaskApi,
  deleteTaskApi,
  purgeTaskApi,
  purgeArchivedWorkspaceTasksApi,
  purgeTerminalTasksApi,
  getTaskSshSessionApi,
  getOrCreateTaskSshSessionApi,
  manualCompleteTaskApi,
  markMergedApi,
  setPendingPromptApi,
  clearPendingPromptApi,
  sendPlanFeedbackApi,
  acceptPlanApi,
  discardPlanApi,
  setPendingApi,
  clearPendingApi,
  addressReviewCommentsApi,
  enablePullRequestAutoMergeApi,
  startAutomaticPrFlowApi,
  stopAutomaticPrFlowApi,
  sendFollowUpApi,
} from "@/hooks/taskActions";
import { createSshSession } from "../helpers/factories";
import type { MessageImageAttachment } from "@/types/message-attachments";

const TASK_ID = "test-task-123";
const SAMPLE_ATTACHMENT: MessageImageAttachment = {
  id: "img-1",
  filename: "screen.png",
  mimeType: "image/png",
  data: "ZmFrZQ==",
  size: 1234,
};

const api = createMockApi();

beforeEach(() => {
  api.reset();
  api.install();
});

afterEach(() => {
  api.uninstall();
});

// ─── acceptTaskApi ───────────────────────────────────────────────────────────

describe("acceptTaskApi", () => {
  test("calls POST /api/tasks/:id/accept and returns result", async () => {
    api.post(`/api/tasks/${TASK_ID}/accept`, () => ({
      success: true,
    }));

    const result = await acceptTaskApi(TASK_ID);

    expect(result).toEqual({ success: true });
    expect(api.calls(`/api/tasks/${TASK_ID}/accept`, "POST")).toHaveLength(1);
  });

  test("throws error with message from error response", async () => {
    api.post(`/api/tasks/${TASK_ID}/accept`, () => {
      throw new MockApiError(500, { message: "Merge conflict detected" });
    });

    await expect(acceptTaskApi(TASK_ID)).rejects.toThrow("Merge conflict detected");
  });

  test("throws fallback error when no message in response", async () => {
    api.post(`/api/tasks/${TASK_ID}/accept`, () => {
      throw new MockApiError(500, {});
    });

    await expect(acceptTaskApi(TASK_ID)).rejects.toThrow("Failed to accept task");
  });
});

// ─── pushTaskApi ─────────────────────────────────────────────────────────────

describe("pushTaskApi", () => {
  test("calls POST /api/tasks/:id/push and returns result", async () => {
    api.post(`/api/tasks/${TASK_ID}/push`, () => ({
      success: true,
      remoteBranch: "feature-branch-a1b2c3d",
    }));

    const result = await pushTaskApi(TASK_ID);

    expect(result).toEqual({ success: true, remoteBranch: "feature-branch-a1b2c3d" });
    expect(api.calls(`/api/tasks/${TASK_ID}/push`, "POST")).toHaveLength(1);
  });

  test("throws error with message from error response", async () => {
    api.post(`/api/tasks/${TASK_ID}/push`, () => {
      throw new MockApiError(500, { message: "Remote rejected push" });
    });

    await expect(pushTaskApi(TASK_ID)).rejects.toThrow("Remote rejected push");
  });

  test("throws fallback error when no message in response", async () => {
    api.post(`/api/tasks/${TASK_ID}/push`, () => {
      throw new MockApiError(500, {});
    });

    await expect(pushTaskApi(TASK_ID)).rejects.toThrow("Failed to push task");
  });
});

// ─── discardTaskApi ──────────────────────────────────────────────────────────

describe("discardTaskApi", () => {
  test("calls POST /api/tasks/:id/discard and returns true", async () => {
    api.post(`/api/tasks/${TASK_ID}/discard`, () => ({ success: true }));

    const result = await discardTaskApi(TASK_ID);

    expect(result).toBe(true);
    expect(api.calls(`/api/tasks/${TASK_ID}/discard`, "POST")).toHaveLength(1);
  });

  test("throws error with message from error response", async () => {
    api.post(`/api/tasks/${TASK_ID}/discard`, () => {
      throw new MockApiError(500, { message: "Cannot discard running task" });
    });

    await expect(discardTaskApi(TASK_ID)).rejects.toThrow("Cannot discard running task");
  });

  test("throws fallback error when no message in response", async () => {
    api.post(`/api/tasks/${TASK_ID}/discard`, () => {
      throw new MockApiError(500, {});
    });

    await expect(discardTaskApi(TASK_ID)).rejects.toThrow("Failed to discard task");
  });
});

// ─── deleteTaskApi ───────────────────────────────────────────────────────────

describe("deleteTaskApi", () => {
  test("calls DELETE /api/tasks/:id and returns true", async () => {
    api.delete(`/api/tasks/${TASK_ID}`, () => ({ success: true }));

    const result = await deleteTaskApi(TASK_ID);

    expect(result).toBe(true);
    expect(api.calls(`/api/tasks/${TASK_ID}`, "DELETE")).toHaveLength(1);
  });

  test("throws error with message from error response", async () => {
    api.delete(`/api/tasks/${TASK_ID}`, () => {
      throw new MockApiError(404, { message: "Task not found" });
    });

    await expect(deleteTaskApi(TASK_ID)).rejects.toThrow("Task not found");
  });

  test("throws fallback error when no message in response", async () => {
    api.delete(`/api/tasks/${TASK_ID}`, () => {
      throw new MockApiError(500, {});
    });

    await expect(deleteTaskApi(TASK_ID)).rejects.toThrow("Failed to delete task");
  });
});

// ─── purgeTaskApi ────────────────────────────────────────────────────────────

describe("purgeTaskApi", () => {
  test("calls POST /api/tasks/:id/purge and returns true", async () => {
    api.post(`/api/tasks/${TASK_ID}/purge`, () => ({ success: true }));

    const result = await purgeTaskApi(TASK_ID);

    expect(result).toBe(true);
    expect(api.calls(`/api/tasks/${TASK_ID}/purge`, "POST")).toHaveLength(1);
  });

  test("throws error with message from error response", async () => {
    api.post(`/api/tasks/${TASK_ID}/purge`, () => {
      throw new MockApiError(500, { message: "Purge failed: branch in use" });
    });

    await expect(purgeTaskApi(TASK_ID)).rejects.toThrow("Purge failed: branch in use");
  });

  test("throws fallback error when no message in response", async () => {
    api.post(`/api/tasks/${TASK_ID}/purge`, () => {
      throw new MockApiError(500, {});
    });

    await expect(purgeTaskApi(TASK_ID)).rejects.toThrow("Failed to purge task");
  });
});

describe("purgeArchivedWorkspaceTasksApi", () => {
  test("calls POST /api/workspaces/:id/archived-tasks/purge and returns summary", async () => {
    api.post("/api/workspaces/ws-1/archived-tasks/purge", () => ({
      success: true,
      workspaceId: "ws-1",
      totalArchived: 2,
      purgedCount: 2,
      purgedTaskIds: ["task-1", "task-2"],
      failures: [],
    }));

    const result = await purgeArchivedWorkspaceTasksApi("ws-1");

    expect(result).toEqual({
      success: true,
      workspaceId: "ws-1",
      totalArchived: 2,
      purgedCount: 2,
      purgedTaskIds: ["task-1", "task-2"],
      failures: [],
    });
    expect(api.calls("/api/workspaces/ws-1/archived-tasks/purge", "POST")).toHaveLength(1);
  });

  test("throws error with message from error response", async () => {
    api.post("/api/workspaces/ws-1/archived-tasks/purge", () => {
      throw new MockApiError(500, { message: "Bulk purge failed" });
    });

    await expect(purgeArchivedWorkspaceTasksApi("ws-1")).rejects.toThrow("Bulk purge failed");
  });
});

describe("purgeTerminalTasksApi", () => {
  test("calls POST /api/settings/purge-terminal-tasks and returns aggregate summary", async () => {
    api.post("/api/settings/purge-terminal-tasks", () => ({
      success: true,
      totalWorkspaces: 2,
      totalArchived: 3,
      purgedCount: 2,
      purgedTaskIds: ["task-1", "task-2"],
      failures: [{ workspaceId: "ws-2", taskId: "task-3", error: "permission denied" }],
      workspaces: [
        {
          workspaceId: "ws-1",
          totalArchived: 2,
          purgedCount: 2,
          purgedTaskIds: ["task-1", "task-2"],
          failures: [],
        },
        {
          workspaceId: "ws-2",
          totalArchived: 1,
          purgedCount: 0,
          purgedTaskIds: [],
          failures: [{ taskId: "task-3", error: "permission denied" }],
        },
      ],
    }));

    const result = await purgeTerminalTasksApi();

    expect(result).toEqual({
      success: true,
      totalWorkspaces: 2,
      totalArchived: 3,
      purgedCount: 2,
      purgedTaskIds: ["task-1", "task-2"],
      failures: [{ workspaceId: "ws-2", taskId: "task-3", error: "permission denied" }],
      workspaces: [
        {
          workspaceId: "ws-1",
          totalArchived: 2,
          purgedCount: 2,
          purgedTaskIds: ["task-1", "task-2"],
          failures: [],
        },
        {
          workspaceId: "ws-2",
          totalArchived: 1,
          purgedCount: 0,
          purgedTaskIds: [],
          failures: [{ taskId: "task-3", error: "permission denied" }],
        },
      ],
    });
    expect(api.calls("/api/settings/purge-terminal-tasks", "POST")).toHaveLength(1);
  });

  test("keeps local success true when the response body includes a success field", async () => {
    api.post("/api/settings/purge-terminal-tasks", () => ({
      success: false,
      totalWorkspaces: 1,
      totalArchived: 0,
      purgedCount: 0,
      purgedTaskIds: [],
      failures: [],
      workspaces: [],
    }));

    const result = await purgeTerminalTasksApi();

    expect(result.success).toBe(true);
  });
});

describe("task SSH session APIs", () => {
  test("getTaskSshSessionApi calls GET /api/tasks/:id/ssh-session", async () => {
    const session = createSshSession({ config: { taskId: TASK_ID } });
    api.get(`/api/tasks/${TASK_ID}/ssh-session`, () => session);

    const result = await getTaskSshSessionApi(TASK_ID);

    expect(result).toEqual(session);
    expect(api.calls(`/api/tasks/${TASK_ID}/ssh-session`, "GET")).toHaveLength(1);
  });

  test("getOrCreateTaskSshSessionApi calls POST /api/tasks/:id/ssh-session", async () => {
    const session = createSshSession({ config: { taskId: TASK_ID } });
    api.post(`/api/tasks/${TASK_ID}/ssh-session`, () => session, 200);

    const result = await getOrCreateTaskSshSessionApi(TASK_ID);

    expect(result).toEqual(session);
    expect(api.calls(`/api/tasks/${TASK_ID}/ssh-session`, "POST")).toHaveLength(1);
  });

  test("getOrCreateTaskSshSessionApi surfaces API errors", async () => {
    api.post(`/api/tasks/${TASK_ID}/ssh-session`, () => {
      throw new MockApiError(400, { message: "SSH sessions require a workspace configured with ssh transport" });
    }, 200);

    await expect(getOrCreateTaskSshSessionApi(TASK_ID)).rejects.toThrow(
      "SSH sessions require a workspace configured with ssh transport",
    );
  });
});

describe("sendFollowUpApi", () => {
  test("calls POST /api/tasks/:id/follow-up and returns true", async () => {
    api.post(`/api/tasks/${TASK_ID}/follow-up`, () => ({ success: true }));

    const result = await sendFollowUpApi(TASK_ID, "Please restart this", {
      providerID: "anthropic",
      modelID: "claude-sonnet-4-20250514",
    });

    expect(result).toBe(true);
    expect(api.calls(`/api/tasks/${TASK_ID}/follow-up`, "POST")).toHaveLength(1);
  });

  test("throws error with message from error response", async () => {
    api.post(`/api/tasks/${TASK_ID}/follow-up`, () => {
      throw new MockApiError(400, { message: "Task cannot accept a terminal follow-up" });
    });

    await expect(sendFollowUpApi(TASK_ID, "Please restart this")).rejects.toThrow(
      "Task cannot accept a terminal follow-up",
    );
  });

  test("includes attachments in the request body", async () => {
    api.post(`/api/tasks/${TASK_ID}/follow-up`, () => ({ success: true }));

    await sendFollowUpApi(TASK_ID, "Please restart this", undefined, [SAMPLE_ATTACHMENT]);

    expect(api.calls(`/api/tasks/${TASK_ID}/follow-up`, "POST")[0]?.body).toEqual({
      message: "Please restart this",
      model: null,
      attachments: [SAMPLE_ATTACHMENT],
      promptMode: "task_context",
    });
  });

  test("includes plain chat mode in the request body when requested", async () => {
    api.post(`/api/tasks/${TASK_ID}/follow-up`, () => ({ success: true }));

    await sendFollowUpApi(TASK_ID, "Please answer directly", undefined, [], "plain_chat");

    expect(api.calls(`/api/tasks/${TASK_ID}/follow-up`, "POST")[0]?.body).toEqual({
      message: "Please answer directly",
      model: null,
      attachments: [],
      promptMode: "plain_chat",
    });
  });
});

// ─── markMergedApi ───────────────────────────────────────────────────────────

describe("markMergedApi", () => {
  test("calls POST /api/tasks/:id/mark-merged and returns true", async () => {
    api.post(`/api/tasks/${TASK_ID}/mark-merged`, () => ({ success: true }));

    const result = await markMergedApi(TASK_ID);

    expect(result).toBe(true);
    expect(api.calls(`/api/tasks/${TASK_ID}/mark-merged`, "POST")).toHaveLength(1);
  });

  test("throws error with message from error response", async () => {
    api.post(`/api/tasks/${TASK_ID}/mark-merged`, () => {
      throw new MockApiError(400, { message: "Task is not in pushed state" });
    });

    await expect(markMergedApi(TASK_ID)).rejects.toThrow("Task is not in pushed state");
  });

  test("throws fallback error when no message in response", async () => {
    api.post(`/api/tasks/${TASK_ID}/mark-merged`, () => {
      throw new MockApiError(500, {});
    });

    await expect(markMergedApi(TASK_ID)).rejects.toThrow("Failed to mark task as merged");
  });
});

// ─── manualCompleteTaskApi ────────────────────────────────────────────────────

describe("manualCompleteTaskApi", () => {
  test("calls POST /api/tasks/:id/manual-complete and returns true", async () => {
    api.post(`/api/tasks/${TASK_ID}/manual-complete`, () => ({ success: true }));

    const result = await manualCompleteTaskApi(TASK_ID);

    expect(result).toBe(true);
    expect(api.calls(`/api/tasks/${TASK_ID}/manual-complete`, "POST")).toHaveLength(1);
  });

  test("throws error with message from error response", async () => {
    api.post(`/api/tasks/${TASK_ID}/manual-complete`, () => {
      throw new MockApiError(400, { message: "Only stopped or failed tasks can be manually completed" });
    });

    await expect(manualCompleteTaskApi(TASK_ID)).rejects.toThrow(
      "Only stopped or failed tasks can be manually completed",
    );
  });

  test("throws fallback error when no message in response", async () => {
    api.post(`/api/tasks/${TASK_ID}/manual-complete`, () => {
      throw new MockApiError(500, {});
    });

    await expect(manualCompleteTaskApi(TASK_ID)).rejects.toThrow("Failed to manually complete task");
  });
});

// ─── setPendingPromptApi ─────────────────────────────────────────────────────

describe("setPendingPromptApi", () => {
  test("calls PUT /api/tasks/:id/pending-prompt with prompt body and returns true", async () => {
    api.put(`/api/tasks/${TASK_ID}/pending-prompt`, () => ({ success: true }));

    const result = await setPendingPromptApi(TASK_ID, "Do this next");

    expect(result).toBe(true);
    const calls = api.calls(`/api/tasks/${TASK_ID}/pending-prompt`, "PUT");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ prompt: "Do this next", attachments: [] });
  });

  test("throws error with message from error response", async () => {
    api.put(`/api/tasks/${TASK_ID}/pending-prompt`, () => {
      throw new MockApiError(400, { message: "Prompt cannot be empty" });
    });

    await expect(setPendingPromptApi(TASK_ID, "")).rejects.toThrow("Prompt cannot be empty");
  });

  test("throws fallback error when no message in response", async () => {
    api.put(`/api/tasks/${TASK_ID}/pending-prompt`, () => {
      throw new MockApiError(500, {});
    });

    await expect(setPendingPromptApi(TASK_ID, "test")).rejects.toThrow("Failed to set pending prompt");
  });

  test("includes attachments in the request body when provided", async () => {
    api.put(`/api/tasks/${TASK_ID}/pending-prompt`, () => ({ success: true }));

    await setPendingPromptApi(TASK_ID, "Do this next", [SAMPLE_ATTACHMENT]);

    expect(api.calls(`/api/tasks/${TASK_ID}/pending-prompt`, "PUT")[0]?.body).toEqual({
      prompt: "Do this next",
      attachments: [SAMPLE_ATTACHMENT],
    });
  });
});

// ─── clearPendingPromptApi ───────────────────────────────────────────────────

describe("clearPendingPromptApi", () => {
  test("calls DELETE /api/tasks/:id/pending-prompt and returns true", async () => {
    api.delete(`/api/tasks/${TASK_ID}/pending-prompt`, () => ({ success: true }));

    const result = await clearPendingPromptApi(TASK_ID);

    expect(result).toBe(true);
    expect(api.calls(`/api/tasks/${TASK_ID}/pending-prompt`, "DELETE")).toHaveLength(1);
  });

  test("throws error with message from error response", async () => {
    api.delete(`/api/tasks/${TASK_ID}/pending-prompt`, () => {
      throw new MockApiError(404, { message: "No pending prompt to clear" });
    });

    await expect(clearPendingPromptApi(TASK_ID)).rejects.toThrow("No pending prompt to clear");
  });

  test("throws fallback error when no message in response", async () => {
    api.delete(`/api/tasks/${TASK_ID}/pending-prompt`, () => {
      throw new MockApiError(500, {});
    });

    await expect(clearPendingPromptApi(TASK_ID)).rejects.toThrow("Failed to clear pending prompt");
  });
});

// ─── sendPlanFeedbackApi ─────────────────────────────────────────────────────

describe("sendPlanFeedbackApi", () => {
  test("calls POST /api/tasks/:id/plan/feedback with feedback body and returns true", async () => {
    api.post(`/api/tasks/${TASK_ID}/plan/feedback`, () => ({ success: true }));

    const result = await sendPlanFeedbackApi(TASK_ID, "Add error handling");

    expect(result).toBe(true);
    const calls = api.calls(`/api/tasks/${TASK_ID}/plan/feedback`, "POST");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ feedback: "Add error handling", attachments: [] });
  });

  test("throws error with message from error response", async () => {
    api.post(`/api/tasks/${TASK_ID}/plan/feedback`, () => {
      throw new MockApiError(400, { message: "Task is not in planning state" });
    });

    await expect(sendPlanFeedbackApi(TASK_ID, "feedback")).rejects.toThrow("Task is not in planning state");
  });

  test("throws fallback error when no message in response", async () => {
    api.post(`/api/tasks/${TASK_ID}/plan/feedback`, () => {
      throw new MockApiError(500, {});
    });

    await expect(sendPlanFeedbackApi(TASK_ID, "feedback")).rejects.toThrow("Failed to send plan feedback");
  });
});

// ─── acceptPlanApi ───────────────────────────────────────────────────────────

describe("acceptPlanApi", () => {
  test("posts start_task mode and returns the start-task result", async () => {
    api.post(`/api/tasks/${TASK_ID}/plan/accept`, (req) => {
      expect(req.body).toEqual({ mode: "start_task" });
      return { success: true, mode: "start_task" };
    }, 200);

    const result = await acceptPlanApi(TASK_ID);

    expect(result).toEqual({ success: true, mode: "start_task" });
    expect(api.calls(`/api/tasks/${TASK_ID}/plan/accept`, "POST")).toHaveLength(1);
  });

  test("posts open_ssh mode and returns the linked ssh session", async () => {
    const session = createSshSession({ config: { id: "ssh-1", taskId: TASK_ID } });
    api.post(`/api/tasks/${TASK_ID}/plan/accept`, (req) => {
      expect(req.body).toEqual({ mode: "open_ssh" });
      return { success: true, mode: "open_ssh", sshSession: session };
    }, 200);

    const result = await acceptPlanApi(TASK_ID, "open_ssh");

    expect(result).toEqual({ success: true, mode: "open_ssh", sshSession: session });
  });

  test("throws error with message from error response", async () => {
    api.post(`/api/tasks/${TASK_ID}/plan/accept`, () => {
      throw new MockApiError(400, { message: "Plan is not ready" });
    });

    await expect(acceptPlanApi(TASK_ID)).rejects.toThrow("Plan is not ready");
  });

  test("throws fallback error when no message in response", async () => {
    api.post(`/api/tasks/${TASK_ID}/plan/accept`, () => {
      throw new MockApiError(500, {});
    });

    await expect(acceptPlanApi(TASK_ID)).rejects.toThrow("Failed to accept plan");
  });
});

// ─── discardPlanApi ──────────────────────────────────────────────────────────

describe("discardPlanApi", () => {
  test("calls POST /api/tasks/:id/plan/discard and returns true", async () => {
    api.post(`/api/tasks/${TASK_ID}/plan/discard`, () => ({ success: true }));

    const result = await discardPlanApi(TASK_ID);

    expect(result).toBe(true);
    expect(api.calls(`/api/tasks/${TASK_ID}/plan/discard`, "POST")).toHaveLength(1);
  });

  test("throws error with message from error response", async () => {
    api.post(`/api/tasks/${TASK_ID}/plan/discard`, () => {
      throw new MockApiError(400, { message: "No plan to discard" });
    });

    await expect(discardPlanApi(TASK_ID)).rejects.toThrow("No plan to discard");
  });

  test("throws fallback error when no message in response", async () => {
    api.post(`/api/tasks/${TASK_ID}/plan/discard`, () => {
      throw new MockApiError(500, {});
    });

    await expect(discardPlanApi(TASK_ID)).rejects.toThrow("Failed to discard plan");
  });
});

// ─── setPendingApi ───────────────────────────────────────────────────────────

describe("setPendingApi", () => {
  test("calls POST /api/tasks/:id/pending with message and returns result", async () => {
    api.post(`/api/tasks/${TASK_ID}/pending`, () => ({ success: true }));

    const result = await setPendingApi(TASK_ID, { message: "Next instruction" });

    expect(result).toEqual({ success: true });
    const calls = api.calls(`/api/tasks/${TASK_ID}/pending`, "POST");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ message: "Next instruction", model: null, immediate: true, attachments: [] });
  });

  test("calls POST /api/tasks/:id/pending with model and returns result", async () => {
    api.post(`/api/tasks/${TASK_ID}/pending`, () => ({ success: true }));

    const result = await setPendingApi(TASK_ID, {
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
    });

    expect(result).toEqual({ success: true });
    const calls = api.calls(`/api/tasks/${TASK_ID}/pending`, "POST");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      message: null,
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514", variant: "" },
      immediate: true,
      attachments: [],
    });
  });

  test("calls POST /api/tasks/:id/pending with both message and model", async () => {
    api.post(`/api/tasks/${TASK_ID}/pending`, () => ({ success: true }));

    const result = await setPendingApi(TASK_ID, {
      message: "Fix the bug",
      model: { providerID: "openai", modelID: "gpt-4o" },
    });

    expect(result).toEqual({ success: true });
    const calls = api.calls(`/api/tasks/${TASK_ID}/pending`, "POST");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      message: "Fix the bug",
      model: { providerID: "openai", modelID: "gpt-4o", variant: "" },
      immediate: true,
      attachments: [],
    });
  });

  test("throws error with message from error response", async () => {
    api.post(`/api/tasks/${TASK_ID}/pending`, () => {
      throw new MockApiError(400, { message: "Task is not running" });
    });

    await expect(setPendingApi(TASK_ID, { message: "test" })).rejects.toThrow("Task is not running");
  });

  test("throws fallback error when no message in response", async () => {
    api.post(`/api/tasks/${TASK_ID}/pending`, () => {
      throw new MockApiError(500, {});
    });

    await expect(setPendingApi(TASK_ID, { message: "test" })).rejects.toThrow("Failed to set pending values");
  });
});

// ─── clearPendingApi ─────────────────────────────────────────────────────────

describe("clearPendingApi", () => {
  test("calls DELETE /api/tasks/:id/pending and returns true", async () => {
    api.delete(`/api/tasks/${TASK_ID}/pending`, () => ({ success: true }));

    const result = await clearPendingApi(TASK_ID);

    expect(result).toBe(true);
    expect(api.calls(`/api/tasks/${TASK_ID}/pending`, "DELETE")).toHaveLength(1);
  });

  test("throws error with message from error response", async () => {
    api.delete(`/api/tasks/${TASK_ID}/pending`, () => {
      throw new MockApiError(400, { message: "No pending values to clear" });
    });

    await expect(clearPendingApi(TASK_ID)).rejects.toThrow("No pending values to clear");
  });

  test("throws fallback error when no message in response", async () => {
    api.delete(`/api/tasks/${TASK_ID}/pending`, () => {
      throw new MockApiError(500, {});
    });

    await expect(clearPendingApi(TASK_ID)).rejects.toThrow("Failed to clear pending values");
  });
});

// ─── addressReviewCommentsApi ────────────────────────────────────────────────

describe("addressReviewCommentsApi", () => {
  test("calls POST /api/tasks/:id/address-comments with comments body and returns result", async () => {
    api.post(`/api/tasks/${TASK_ID}/address-comments`, () => ({
      success: true,
      reviewCycle: 2,
      branch: "task-123-a1b2c3d-review-2",
    }));

    const result = await addressReviewCommentsApi(TASK_ID, "Please fix the typo on line 42");

    expect(result).toEqual({
      success: true,
      reviewCycle: 2,
      branch: "task-123-a1b2c3d-review-2",
    });
    const calls = api.calls(`/api/tasks/${TASK_ID}/address-comments`, "POST");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ comments: "Please fix the typo on line 42", attachments: [] });
  });

  test("throws error using message field from error response", async () => {
    api.post(`/api/tasks/${TASK_ID}/address-comments`, () => {
      throw new MockApiError(400, { message: "Comments cannot be empty" });
    });

    await expect(addressReviewCommentsApi(TASK_ID, "")).rejects.toThrow("Comments cannot be empty");
  });

  test("throws error using error field when message is absent", async () => {
    // addressReviewCommentsApi checks errorData.message || errorData.error
    api.post(`/api/tasks/${TASK_ID}/address-comments`, () => {
      throw new MockApiError(400, { error: "Task is not addressable" });
    });

    await expect(addressReviewCommentsApi(TASK_ID, "comments")).rejects.toThrow("Task is not addressable");
  });

  test("throws fallback error when neither message nor error in response", async () => {
    api.post(`/api/tasks/${TASK_ID}/address-comments`, () => {
      throw new MockApiError(500, {});
    });

    await expect(addressReviewCommentsApi(TASK_ID, "comments")).rejects.toThrow("Failed to address comments");
  });
});

describe("automatic PR flow APIs", () => {
  test("startAutomaticPrFlowApi calls POST /api/tasks/:id/automatic-pr-flow/start", async () => {
    api.post(`/api/tasks/${TASK_ID}/automatic-pr-flow/start`, () => ({
      success: true,
      automaticPrFlow: {
        enabled: true,
        status: "monitoring",
        startedAt: "2026-04-11T04:00:00.000Z",
        updatedAt: "2026-04-11T04:00:00.000Z",
        lastCheckedAt: "2026-04-11T04:00:00.000Z",
        pullRequestNumber: 42,
      },
    }));

    const result = await startAutomaticPrFlowApi(TASK_ID);

    expect(result).toEqual({
      success: true,
      automaticPrFlow: {
        enabled: true,
        status: "monitoring",
        startedAt: "2026-04-11T04:00:00.000Z",
        updatedAt: "2026-04-11T04:00:00.000Z",
        lastCheckedAt: "2026-04-11T04:00:00.000Z",
        pullRequestNumber: 42,
      },
    });
    expect(api.calls(`/api/tasks/${TASK_ID}/automatic-pr-flow/start`, "POST")).toHaveLength(1);
  });

  test("stopAutomaticPrFlowApi calls POST /api/tasks/:id/automatic-pr-flow/stop", async () => {
    api.post(`/api/tasks/${TASK_ID}/automatic-pr-flow/stop`, () => ({
      success: true,
      automaticPrFlow: {
        enabled: false,
        status: "stopped",
        startedAt: "2026-04-11T04:00:00.000Z",
        updatedAt: "2026-04-11T04:10:00.000Z",
      },
    }));

    const result = await stopAutomaticPrFlowApi(TASK_ID);

    expect(result).toEqual({
      success: true,
      automaticPrFlow: {
        enabled: false,
        status: "stopped",
        startedAt: "2026-04-11T04:00:00.000Z",
        updatedAt: "2026-04-11T04:10:00.000Z",
      },
    });
    expect(api.calls(`/api/tasks/${TASK_ID}/automatic-pr-flow/stop`, "POST")).toHaveLength(1);
  });

  test("enablePullRequestAutoMergeApi calls POST /api/tasks/:id/pull-request/auto-merge", async () => {
    api.post(`/api/tasks/${TASK_ID}/pull-request/auto-merge`, () => ({
      success: true,
      pullRequest: {
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      },
    }));

    const result = await enablePullRequestAutoMergeApi(TASK_ID);

    expect(result).toEqual({
      success: true,
      pullRequest: {
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      },
    });
    expect(api.calls(`/api/tasks/${TASK_ID}/pull-request/auto-merge`, "POST")).toHaveLength(1);
  });
});
