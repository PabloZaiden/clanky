import { describe, expect, test } from "bun:test";
import { SimpleEventEmitter } from "../../src/core/event-emitter";
import { handleFullyAutonomousCompletionImpl } from "../../src/core/task/task-fully-autonomous";
import { saveTask, loadTask } from "../../src/persistence/tasks";
import type { TaskCtx } from "../../src/core/task/context";
import type { TaskEvent } from "../../src/types/events";
import { setupTestContext, teardownTestContext, testModelFields, testWorkspaceId } from "../setup";

describe("handleFullyAutonomousCompletionImpl", () => {
  test("treats a duplicate push already in progress as a non-fatal no-op", async () => {
    const ctx = await setupTestContext();

    try {
      const task = await ctx.manager.createTask({
        ...testModelFields,
        prompt: "Complete and then continue autonomously",
        name: "Fully Autonomous Task",
        directory: ctx.workDir,
        workspaceId: testWorkspaceId,
        planMode: true,
        autoAcceptPlan: true,
        fullyAutonomous: true,
      });

      const storedTask = await loadTask(task.config.id);
      expect(storedTask).not.toBeNull();
      storedTask!.state.status = "completed";
      storedTask!.state.planMode = {
        active: false,
        feedbackRounds: 0,
        planningFolderCleared: false,
        isPlanReady: true,
      };
      storedTask!.state.fullyAutonomousPending = true;
      await saveTask(storedTask!);

      const events: TaskEvent[] = [];
      const emitter = new SimpleEventEmitter<TaskEvent>();
      emitter.subscribe((event) => events.push(event));

      const taskCtx: TaskCtx = {
        engines: new Map(),
        emitter,
        tasksBeingAccepted: new Set(),
        stopTask: async () => {},
        deleteTask: async () => false,
        discardTask: async () => ({ success: false, error: "unused" }),
        getTask: async () => loadTask(task.config.id),
        startTask: async () => {},
        startPlanMode: async () => {},
        acceptPlan: async () => ({ mode: "start_task" }),
        pushTask: async () => ({ success: false, error: "Operation already in progress" }),
        startAutomaticPrFlow: async () => ({ success: true }),
        startStatePersistence: () => {},
        ensureTaskBranchCheckedOut: async () => {},
        validateMainCheckoutStart: async () => {},
        clearPlanningFiles: async () => {},
        recoverPlanningEngine: async () => {
          throw new Error("unused");
        },
        startFeedbackCycle: async () => ({ success: false, error: "unused" }),
        jumpstartTask: async () => ({ success: false, error: "unused" }),
      };

      await handleFullyAutonomousCompletionImpl(taskCtx, task.config.id);

      const updatedTask = await loadTask(task.config.id);
      expect(updatedTask?.state.fullyAutonomousPending).toBe(true);
      expect(updatedTask?.state.automaticPrFlow).toBeUndefined();
      expect(events).toHaveLength(0);
    } finally {
      await teardownTestContext(ctx);
    }
  });
});
