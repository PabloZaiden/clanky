import { describe, expect, test } from "bun:test";

import { shouldRefreshTaskSnapshotForEvent } from "../../src/hooks/tasks/use-task-events";
import type { TaskEvent } from "../../src/types";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const TASK_ID = "task-1";

describe("task summary event handling", () => {
  test("refreshes task snapshots for low-frequency events that can affect dashboard summaries", () => {
    const events = [
      { type: "task.git.commit", taskId: TASK_ID, iteration: 1, commit: { iteration: 1, sha: "abc123", message: "test", timestamp: TIMESTAMP, filesChanged: 1 }, timestamp: TIMESTAMP },
      { type: "task.pending.updated", taskId: TASK_ID, pendingPrompt: "continue", timestamp: TIMESTAMP },
      { type: "task.sync.started", taskId: TASK_ID, baseBranch: "main", timestamp: TIMESTAMP },
      { type: "task.sync.clean", taskId: TASK_ID, baseBranch: "main", timestamp: TIMESTAMP },
      { type: "task.sync.conflicts", taskId: TASK_ID, baseBranch: "main", conflictedFiles: ["a.ts"], timestamp: TIMESTAMP },
      { type: "task.sync.failed", taskId: TASK_ID, baseBranch: "main", error: "failed", timestamp: TIMESTAMP },
      { type: "task.session_aborted", taskId: TASK_ID, reason: "reset", timestamp: TIMESTAMP },
    ] satisfies TaskEvent[];

    for (const event of events) {
      expect(shouldRefreshTaskSnapshotForEvent(event)).toBe(true);
    }
  });

  test("does not refresh task snapshots for high-frequency stream-only events", () => {
    const events = [
      { type: "task.log", taskId: TASK_ID, id: "log-1", level: "info", message: "log", timestamp: TIMESTAMP },
      { type: "task.message", taskId: TASK_ID, iteration: 1, message: { id: "msg-1", role: "assistant", content: "message", timestamp: TIMESTAMP }, timestamp: TIMESTAMP },
      { type: "task.progress", taskId: TASK_ID, iteration: 1, content: "delta", timestamp: TIMESTAMP },
      { type: "task.tool_call", taskId: TASK_ID, iteration: 1, tool: { id: "tool-1", name: "read", input: {}, status: "pending", timestamp: TIMESTAMP }, timestamp: TIMESTAMP },
      { type: "task.tool_call.extra", taskId: TASK_ID, iteration: 1, toolId: "tool-1", extra: { id: "extra-1", type: "image_preview", image: { id: "image-1", filename: "image.png", mimeType: "image/png", data: "base64", size: 6 } }, timestamp: TIMESTAMP },
    ] satisfies TaskEvent[];

    for (const event of events) {
      expect(shouldRefreshTaskSnapshotForEvent(event)).toBe(false);
    }
  });
});
