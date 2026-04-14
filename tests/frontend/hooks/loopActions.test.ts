/**
 * Tests for loopActions API functions.
 *
 * These are pure async functions that call fetch() and return results or throw errors.
 * Each function is tested for success and error responses.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createMockApi, MockApiError } from "../helpers/mock-api";
import {
  acceptLoopApi,
  pushLoopApi,
  discardLoopApi,
  deleteLoopApi,
  purgeLoopApi,
  purgeArchivedWorkspaceLoopsApi,
  getLoopSshSessionApi,
  getOrCreateLoopSshSessionApi,
  markMergedApi,
  setPendingPromptApi,
  clearPendingPromptApi,
  sendPlanFeedbackApi,
  acceptPlanApi,
  discardPlanApi,
  setPendingApi,
  clearPendingApi,
  addressReviewCommentsApi,
  startAutomaticPrFlowApi,
  stopAutomaticPrFlowApi,
  sendFollowUpApi,
} from "@/hooks/loopActions";
import { createSshSession } from "../helpers/factories";
import type { MessageImageAttachment } from "@/types/message-attachments";

const LOOP_ID = "test-loop-123";
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

// ─── acceptLoopApi ───────────────────────────────────────────────────────────

describe("acceptLoopApi", () => {
  test("calls POST /api/loops/:id/accept and returns result", async () => {
    api.post(`/api/loops/${LOOP_ID}/accept`, () => ({
      success: true,
      mergeCommit: "abc123def",
    }));

    const result = await acceptLoopApi(LOOP_ID);

    expect(result).toEqual({ success: true, mergeCommit: "abc123def" });
    expect(api.calls(`/api/loops/${LOOP_ID}/accept`, "POST")).toHaveLength(1);
  });

  test("throws error with message from error response", async () => {
    api.post(`/api/loops/${LOOP_ID}/accept`, () => {
      throw new MockApiError(500, { message: "Merge conflict detected" });
    });

    await expect(acceptLoopApi(LOOP_ID)).rejects.toThrow("Merge conflict detected");
  });

  test("throws fallback error when no message in response", async () => {
    api.post(`/api/loops/${LOOP_ID}/accept`, () => {
      throw new MockApiError(500, {});
    });

    await expect(acceptLoopApi(LOOP_ID)).rejects.toThrow("Failed to accept loop");
  });
});

// ─── pushLoopApi ─────────────────────────────────────────────────────────────

describe("pushLoopApi", () => {
  test("calls POST /api/loops/:id/push and returns result", async () => {
    api.post(`/api/loops/${LOOP_ID}/push`, () => ({
      success: true,
      remoteBranch: "feature-branch-a1b2c3d",
    }));

    const result = await pushLoopApi(LOOP_ID);

    expect(result).toEqual({ success: true, remoteBranch: "feature-branch-a1b2c3d" });
    expect(api.calls(`/api/loops/${LOOP_ID}/push`, "POST")).toHaveLength(1);
  });

  test("throws error with message from error response", async () => {
    api.post(`/api/loops/${LOOP_ID}/push`, () => {
      throw new MockApiError(500, { message: "Remote rejected push" });
    });

    await expect(pushLoopApi(LOOP_ID)).rejects.toThrow("Remote rejected push");
  });

  test("throws fallback error when no message in response", async () => {
    api.post(`/api/loops/${LOOP_ID}/push`, () => {
      throw new MockApiError(500, {});
    });

    await expect(pushLoopApi(LOOP_ID)).rejects.toThrow("Failed to push loop");
  });
});

// ─── discardLoopApi ──────────────────────────────────────────────────────────

describe("discardLoopApi", () => {
  test("calls POST /api/loops/:id/discard and returns true", async () => {
    api.post(`/api/loops/${LOOP_ID}/discard`, () => ({ success: true }));

    const result = await discardLoopApi(LOOP_ID);

    expect(result).toBe(true);
    expect(api.calls(`/api/loops/${LOOP_ID}/discard`, "POST")).toHaveLength(1);
  });

  test("throws error with message from error response", async () => {
    api.post(`/api/loops/${LOOP_ID}/discard`, () => {
      throw new MockApiError(500, { message: "Cannot discard running loop" });
    });

    await expect(discardLoopApi(LOOP_ID)).rejects.toThrow("Cannot discard running loop");
  });

  test("throws fallback error when no message in response", async () => {
    api.post(`/api/loops/${LOOP_ID}/discard`, () => {
      throw new MockApiError(500, {});
    });

    await expect(discardLoopApi(LOOP_ID)).rejects.toThrow("Failed to discard loop");
  });
});

// ─── deleteLoopApi ───────────────────────────────────────────────────────────

describe("deleteLoopApi", () => {
  test("calls DELETE /api/loops/:id and returns true", async () => {
    api.delete(`/api/loops/${LOOP_ID}`, () => ({ success: true }));

    const result = await deleteLoopApi(LOOP_ID);

    expect(result).toBe(true);
    expect(api.calls(`/api/loops/${LOOP_ID}`, "DELETE")).toHaveLength(1);
  });

  test("throws error with message from error response", async () => {
    api.delete(`/api/loops/${LOOP_ID}`, () => {
      throw new MockApiError(404, { message: "Loop not found" });
    });

    await expect(deleteLoopApi(LOOP_ID)).rejects.toThrow("Loop not found");
  });

  test("throws fallback error when no message in response", async () => {
    api.delete(`/api/loops/${LOOP_ID}`, () => {
      throw new MockApiError(500, {});
    });

    await expect(deleteLoopApi(LOOP_ID)).rejects.toThrow("Failed to delete loop");
  });
});

// ─── purgeLoopApi ────────────────────────────────────────────────────────────

describe("purgeLoopApi", () => {
  test("calls POST /api/loops/:id/purge and returns true", async () => {
    api.post(`/api/loops/${LOOP_ID}/purge`, () => ({ success: true }));

    const result = await purgeLoopApi(LOOP_ID);

    expect(result).toBe(true);
    expect(api.calls(`/api/loops/${LOOP_ID}/purge`, "POST")).toHaveLength(1);
  });

  test("throws error with message from error response", async () => {
    api.post(`/api/loops/${LOOP_ID}/purge`, () => {
      throw new MockApiError(500, { message: "Purge failed: branch in use" });
    });

    await expect(purgeLoopApi(LOOP_ID)).rejects.toThrow("Purge failed: branch in use");
  });

  test("throws fallback error when no message in response", async () => {
    api.post(`/api/loops/${LOOP_ID}/purge`, () => {
      throw new MockApiError(500, {});
    });

    await expect(purgeLoopApi(LOOP_ID)).rejects.toThrow("Failed to purge loop");
  });
});

describe("purgeArchivedWorkspaceLoopsApi", () => {
  test("calls POST /api/workspaces/:id/archived-loops/purge and returns summary", async () => {
    api.post("/api/workspaces/ws-1/archived-loops/purge", () => ({
      success: true,
      workspaceId: "ws-1",
      totalArchived: 2,
      purgedCount: 2,
      purgedLoopIds: ["loop-1", "loop-2"],
      failures: [],
    }));

    const result = await purgeArchivedWorkspaceLoopsApi("ws-1");

    expect(result).toEqual({
      success: true,
      workspaceId: "ws-1",
      totalArchived: 2,
      purgedCount: 2,
      purgedLoopIds: ["loop-1", "loop-2"],
      failures: [],
    });
    expect(api.calls("/api/workspaces/ws-1/archived-loops/purge", "POST")).toHaveLength(1);
  });

  test("throws error with message from error response", async () => {
    api.post("/api/workspaces/ws-1/archived-loops/purge", () => {
      throw new MockApiError(500, { message: "Bulk purge failed" });
    });

    await expect(purgeArchivedWorkspaceLoopsApi("ws-1")).rejects.toThrow("Bulk purge failed");
  });
});

describe("loop SSH session APIs", () => {
  test("getLoopSshSessionApi calls GET /api/loops/:id/ssh-session", async () => {
    const session = createSshSession({ config: { loopId: LOOP_ID } });
    api.get(`/api/loops/${LOOP_ID}/ssh-session`, () => session);

    const result = await getLoopSshSessionApi(LOOP_ID);

    expect(result).toEqual(session);
    expect(api.calls(`/api/loops/${LOOP_ID}/ssh-session`, "GET")).toHaveLength(1);
  });

  test("getOrCreateLoopSshSessionApi calls POST /api/loops/:id/ssh-session", async () => {
    const session = createSshSession({ config: { loopId: LOOP_ID } });
    api.post(`/api/loops/${LOOP_ID}/ssh-session`, () => session, 200);

    const result = await getOrCreateLoopSshSessionApi(LOOP_ID);

    expect(result).toEqual(session);
    expect(api.calls(`/api/loops/${LOOP_ID}/ssh-session`, "POST")).toHaveLength(1);
  });

  test("getOrCreateLoopSshSessionApi surfaces API errors", async () => {
    api.post(`/api/loops/${LOOP_ID}/ssh-session`, () => {
      throw new MockApiError(400, { message: "SSH sessions require a workspace configured with ssh transport" });
    }, 200);

    await expect(getOrCreateLoopSshSessionApi(LOOP_ID)).rejects.toThrow(
      "SSH sessions require a workspace configured with ssh transport",
    );
  });
});

describe("sendFollowUpApi", () => {
  test("calls POST /api/loops/:id/follow-up and returns true", async () => {
    api.post(`/api/loops/${LOOP_ID}/follow-up`, () => ({ success: true }));

    const result = await sendFollowUpApi(LOOP_ID, "Please restart this", {
      providerID: "anthropic",
      modelID: "claude-sonnet-4-20250514",
    });

    expect(result).toBe(true);
    expect(api.calls(`/api/loops/${LOOP_ID}/follow-up`, "POST")).toHaveLength(1);
  });

  test("throws error with message from error response", async () => {
    api.post(`/api/loops/${LOOP_ID}/follow-up`, () => {
      throw new MockApiError(400, { message: "Loop cannot accept a terminal follow-up" });
    });

    await expect(sendFollowUpApi(LOOP_ID, "Please restart this")).rejects.toThrow(
      "Loop cannot accept a terminal follow-up",
    );
  });

  test("includes attachments in the request body", async () => {
    api.post(`/api/loops/${LOOP_ID}/follow-up`, () => ({ success: true }));

    await sendFollowUpApi(LOOP_ID, "Please restart this", undefined, [SAMPLE_ATTACHMENT]);

    expect(api.calls(`/api/loops/${LOOP_ID}/follow-up`, "POST")[0]?.body).toEqual({
      message: "Please restart this",
      model: null,
      attachments: [SAMPLE_ATTACHMENT],
    });
  });
});

// ─── markMergedApi ───────────────────────────────────────────────────────────

describe("markMergedApi", () => {
  test("calls POST /api/loops/:id/mark-merged and returns true", async () => {
    api.post(`/api/loops/${LOOP_ID}/mark-merged`, () => ({ success: true }));

    const result = await markMergedApi(LOOP_ID);

    expect(result).toBe(true);
    expect(api.calls(`/api/loops/${LOOP_ID}/mark-merged`, "POST")).toHaveLength(1);
  });

  test("throws error with message from error response", async () => {
    api.post(`/api/loops/${LOOP_ID}/mark-merged`, () => {
      throw new MockApiError(400, { message: "Loop is not in pushed state" });
    });

    await expect(markMergedApi(LOOP_ID)).rejects.toThrow("Loop is not in pushed state");
  });

  test("throws fallback error when no message in response", async () => {
    api.post(`/api/loops/${LOOP_ID}/mark-merged`, () => {
      throw new MockApiError(500, {});
    });

    await expect(markMergedApi(LOOP_ID)).rejects.toThrow("Failed to mark loop as merged");
  });
});

// ─── setPendingPromptApi ─────────────────────────────────────────────────────

describe("setPendingPromptApi", () => {
  test("calls PUT /api/loops/:id/pending-prompt with prompt body and returns true", async () => {
    api.put(`/api/loops/${LOOP_ID}/pending-prompt`, () => ({ success: true }));

    const result = await setPendingPromptApi(LOOP_ID, "Do this next");

    expect(result).toBe(true);
    const calls = api.calls(`/api/loops/${LOOP_ID}/pending-prompt`, "PUT");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ prompt: "Do this next", attachments: [] });
  });

  test("throws error with message from error response", async () => {
    api.put(`/api/loops/${LOOP_ID}/pending-prompt`, () => {
      throw new MockApiError(400, { message: "Prompt cannot be empty" });
    });

    await expect(setPendingPromptApi(LOOP_ID, "")).rejects.toThrow("Prompt cannot be empty");
  });

  test("throws fallback error when no message in response", async () => {
    api.put(`/api/loops/${LOOP_ID}/pending-prompt`, () => {
      throw new MockApiError(500, {});
    });

    await expect(setPendingPromptApi(LOOP_ID, "test")).rejects.toThrow("Failed to set pending prompt");
  });

  test("includes attachments in the request body when provided", async () => {
    api.put(`/api/loops/${LOOP_ID}/pending-prompt`, () => ({ success: true }));

    await setPendingPromptApi(LOOP_ID, "Do this next", [SAMPLE_ATTACHMENT]);

    expect(api.calls(`/api/loops/${LOOP_ID}/pending-prompt`, "PUT")[0]?.body).toEqual({
      prompt: "Do this next",
      attachments: [SAMPLE_ATTACHMENT],
    });
  });
});

// ─── clearPendingPromptApi ───────────────────────────────────────────────────

describe("clearPendingPromptApi", () => {
  test("calls DELETE /api/loops/:id/pending-prompt and returns true", async () => {
    api.delete(`/api/loops/${LOOP_ID}/pending-prompt`, () => ({ success: true }));

    const result = await clearPendingPromptApi(LOOP_ID);

    expect(result).toBe(true);
    expect(api.calls(`/api/loops/${LOOP_ID}/pending-prompt`, "DELETE")).toHaveLength(1);
  });

  test("throws error with message from error response", async () => {
    api.delete(`/api/loops/${LOOP_ID}/pending-prompt`, () => {
      throw new MockApiError(404, { message: "No pending prompt to clear" });
    });

    await expect(clearPendingPromptApi(LOOP_ID)).rejects.toThrow("No pending prompt to clear");
  });

  test("throws fallback error when no message in response", async () => {
    api.delete(`/api/loops/${LOOP_ID}/pending-prompt`, () => {
      throw new MockApiError(500, {});
    });

    await expect(clearPendingPromptApi(LOOP_ID)).rejects.toThrow("Failed to clear pending prompt");
  });
});

// ─── sendPlanFeedbackApi ─────────────────────────────────────────────────────

describe("sendPlanFeedbackApi", () => {
  test("calls POST /api/loops/:id/plan/feedback with feedback body and returns true", async () => {
    api.post(`/api/loops/${LOOP_ID}/plan/feedback`, () => ({ success: true }));

    const result = await sendPlanFeedbackApi(LOOP_ID, "Add error handling");

    expect(result).toBe(true);
    const calls = api.calls(`/api/loops/${LOOP_ID}/plan/feedback`, "POST");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ feedback: "Add error handling", attachments: [] });
  });

  test("throws error with message from error response", async () => {
    api.post(`/api/loops/${LOOP_ID}/plan/feedback`, () => {
      throw new MockApiError(400, { message: "Loop is not in planning state" });
    });

    await expect(sendPlanFeedbackApi(LOOP_ID, "feedback")).rejects.toThrow("Loop is not in planning state");
  });

  test("throws fallback error when no message in response", async () => {
    api.post(`/api/loops/${LOOP_ID}/plan/feedback`, () => {
      throw new MockApiError(500, {});
    });

    await expect(sendPlanFeedbackApi(LOOP_ID, "feedback")).rejects.toThrow("Failed to send plan feedback");
  });
});

// ─── acceptPlanApi ───────────────────────────────────────────────────────────

describe("acceptPlanApi", () => {
  test("posts start_loop mode and returns the start-loop result", async () => {
    api.post(`/api/loops/${LOOP_ID}/plan/accept`, (req) => {
      expect(req.body).toEqual({ mode: "start_loop" });
      return { success: true, mode: "start_loop" };
    }, 200);

    const result = await acceptPlanApi(LOOP_ID);

    expect(result).toEqual({ success: true, mode: "start_loop" });
    expect(api.calls(`/api/loops/${LOOP_ID}/plan/accept`, "POST")).toHaveLength(1);
  });

  test("posts open_ssh mode and returns the linked ssh session", async () => {
    const session = createSshSession({ config: { id: "ssh-1", loopId: LOOP_ID } });
    api.post(`/api/loops/${LOOP_ID}/plan/accept`, (req) => {
      expect(req.body).toEqual({ mode: "open_ssh" });
      return { success: true, mode: "open_ssh", sshSession: session };
    }, 200);

    const result = await acceptPlanApi(LOOP_ID, "open_ssh");

    expect(result).toEqual({ success: true, mode: "open_ssh", sshSession: session });
  });

  test("throws error with message from error response", async () => {
    api.post(`/api/loops/${LOOP_ID}/plan/accept`, () => {
      throw new MockApiError(400, { message: "Plan is not ready" });
    });

    await expect(acceptPlanApi(LOOP_ID)).rejects.toThrow("Plan is not ready");
  });

  test("throws fallback error when no message in response", async () => {
    api.post(`/api/loops/${LOOP_ID}/plan/accept`, () => {
      throw new MockApiError(500, {});
    });

    await expect(acceptPlanApi(LOOP_ID)).rejects.toThrow("Failed to accept plan");
  });
});

// ─── discardPlanApi ──────────────────────────────────────────────────────────

describe("discardPlanApi", () => {
  test("calls POST /api/loops/:id/plan/discard and returns true", async () => {
    api.post(`/api/loops/${LOOP_ID}/plan/discard`, () => ({ success: true }));

    const result = await discardPlanApi(LOOP_ID);

    expect(result).toBe(true);
    expect(api.calls(`/api/loops/${LOOP_ID}/plan/discard`, "POST")).toHaveLength(1);
  });

  test("throws error with message from error response", async () => {
    api.post(`/api/loops/${LOOP_ID}/plan/discard`, () => {
      throw new MockApiError(400, { message: "No plan to discard" });
    });

    await expect(discardPlanApi(LOOP_ID)).rejects.toThrow("No plan to discard");
  });

  test("throws fallback error when no message in response", async () => {
    api.post(`/api/loops/${LOOP_ID}/plan/discard`, () => {
      throw new MockApiError(500, {});
    });

    await expect(discardPlanApi(LOOP_ID)).rejects.toThrow("Failed to discard plan");
  });
});

// ─── setPendingApi ───────────────────────────────────────────────────────────

describe("setPendingApi", () => {
  test("calls POST /api/loops/:id/pending with message and returns result", async () => {
    api.post(`/api/loops/${LOOP_ID}/pending`, () => ({ success: true }));

    const result = await setPendingApi(LOOP_ID, { message: "Next instruction" });

    expect(result).toEqual({ success: true });
    const calls = api.calls(`/api/loops/${LOOP_ID}/pending`, "POST");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ message: "Next instruction", model: null, immediate: true, attachments: [] });
  });

  test("calls POST /api/loops/:id/pending with model and returns result", async () => {
    api.post(`/api/loops/${LOOP_ID}/pending`, () => ({ success: true }));

    const result = await setPendingApi(LOOP_ID, {
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
    });

    expect(result).toEqual({ success: true });
    const calls = api.calls(`/api/loops/${LOOP_ID}/pending`, "POST");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      message: null,
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514", variant: "" },
      immediate: true,
      attachments: [],
    });
  });

  test("calls POST /api/loops/:id/pending with both message and model", async () => {
    api.post(`/api/loops/${LOOP_ID}/pending`, () => ({ success: true }));

    const result = await setPendingApi(LOOP_ID, {
      message: "Fix the bug",
      model: { providerID: "openai", modelID: "gpt-4o" },
    });

    expect(result).toEqual({ success: true });
    const calls = api.calls(`/api/loops/${LOOP_ID}/pending`, "POST");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      message: "Fix the bug",
      model: { providerID: "openai", modelID: "gpt-4o", variant: "" },
      immediate: true,
      attachments: [],
    });
  });

  test("throws error with message from error response", async () => {
    api.post(`/api/loops/${LOOP_ID}/pending`, () => {
      throw new MockApiError(400, { message: "Loop is not running" });
    });

    await expect(setPendingApi(LOOP_ID, { message: "test" })).rejects.toThrow("Loop is not running");
  });

  test("throws fallback error when no message in response", async () => {
    api.post(`/api/loops/${LOOP_ID}/pending`, () => {
      throw new MockApiError(500, {});
    });

    await expect(setPendingApi(LOOP_ID, { message: "test" })).rejects.toThrow("Failed to set pending values");
  });
});

// ─── clearPendingApi ─────────────────────────────────────────────────────────

describe("clearPendingApi", () => {
  test("calls DELETE /api/loops/:id/pending and returns true", async () => {
    api.delete(`/api/loops/${LOOP_ID}/pending`, () => ({ success: true }));

    const result = await clearPendingApi(LOOP_ID);

    expect(result).toBe(true);
    expect(api.calls(`/api/loops/${LOOP_ID}/pending`, "DELETE")).toHaveLength(1);
  });

  test("throws error with message from error response", async () => {
    api.delete(`/api/loops/${LOOP_ID}/pending`, () => {
      throw new MockApiError(400, { message: "No pending values to clear" });
    });

    await expect(clearPendingApi(LOOP_ID)).rejects.toThrow("No pending values to clear");
  });

  test("throws fallback error when no message in response", async () => {
    api.delete(`/api/loops/${LOOP_ID}/pending`, () => {
      throw new MockApiError(500, {});
    });

    await expect(clearPendingApi(LOOP_ID)).rejects.toThrow("Failed to clear pending values");
  });
});

// ─── addressReviewCommentsApi ────────────────────────────────────────────────

describe("addressReviewCommentsApi", () => {
  test("calls POST /api/loops/:id/address-comments with comments body and returns result", async () => {
    api.post(`/api/loops/${LOOP_ID}/address-comments`, () => ({
      success: true,
      reviewCycle: 2,
      branch: "loop-123-a1b2c3d-review-2",
    }));

    const result = await addressReviewCommentsApi(LOOP_ID, "Please fix the typo on line 42");

    expect(result).toEqual({
      success: true,
      reviewCycle: 2,
      branch: "loop-123-a1b2c3d-review-2",
    });
    const calls = api.calls(`/api/loops/${LOOP_ID}/address-comments`, "POST");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ comments: "Please fix the typo on line 42", attachments: [] });
  });

  test("throws error using message field from error response", async () => {
    api.post(`/api/loops/${LOOP_ID}/address-comments`, () => {
      throw new MockApiError(400, { message: "Comments cannot be empty" });
    });

    await expect(addressReviewCommentsApi(LOOP_ID, "")).rejects.toThrow("Comments cannot be empty");
  });

  test("throws error using error field when message is absent", async () => {
    // addressReviewCommentsApi checks errorData.message || errorData.error
    api.post(`/api/loops/${LOOP_ID}/address-comments`, () => {
      throw new MockApiError(400, { error: "Loop is not addressable" });
    });

    await expect(addressReviewCommentsApi(LOOP_ID, "comments")).rejects.toThrow("Loop is not addressable");
  });

  test("throws fallback error when neither message nor error in response", async () => {
    api.post(`/api/loops/${LOOP_ID}/address-comments`, () => {
      throw new MockApiError(500, {});
    });

    await expect(addressReviewCommentsApi(LOOP_ID, "comments")).rejects.toThrow("Failed to address comments");
  });
});

describe("automatic PR flow APIs", () => {
  test("startAutomaticPrFlowApi calls POST /api/loops/:id/automatic-pr-flow/start", async () => {
    api.post(`/api/loops/${LOOP_ID}/automatic-pr-flow/start`, () => ({
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

    const result = await startAutomaticPrFlowApi(LOOP_ID);

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
    expect(api.calls(`/api/loops/${LOOP_ID}/automatic-pr-flow/start`, "POST")).toHaveLength(1);
  });

  test("stopAutomaticPrFlowApi calls POST /api/loops/:id/automatic-pr-flow/stop", async () => {
    api.post(`/api/loops/${LOOP_ID}/automatic-pr-flow/stop`, () => ({
      success: true,
      automaticPrFlow: {
        enabled: false,
        status: "stopped",
        startedAt: "2026-04-11T04:00:00.000Z",
        updatedAt: "2026-04-11T04:10:00.000Z",
      },
    }));

    const result = await stopAutomaticPrFlowApi(LOOP_ID);

    expect(result).toEqual({
      success: true,
      automaticPrFlow: {
        enabled: false,
        status: "stopped",
        startedAt: "2026-04-11T04:00:00.000Z",
        updatedAt: "2026-04-11T04:10:00.000Z",
      },
    });
    expect(api.calls(`/api/loops/${LOOP_ID}/automatic-pr-flow/stop`, "POST")).toHaveLength(1);
  });
});
