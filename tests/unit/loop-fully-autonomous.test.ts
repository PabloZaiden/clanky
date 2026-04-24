import { describe, expect, test } from "bun:test";
import { SimpleEventEmitter } from "../../src/core/event-emitter";
import { handleFullyAutonomousCompletionImpl } from "../../src/core/loop/loop-fully-autonomous";
import { saveLoop, loadLoop } from "../../src/persistence/loops";
import type { LoopCtx } from "../../src/core/loop/context";
import type { LoopEvent } from "../../src/types/events";
import { setupTestContext, teardownTestContext, testModelFields, testWorkspaceId } from "../setup";

describe("handleFullyAutonomousCompletionImpl", () => {
  test("treats a duplicate push already in progress as a non-fatal no-op", async () => {
    const ctx = await setupTestContext();

    try {
      const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Complete and then continue autonomously",
        name: "Fully Autonomous Loop",
        directory: ctx.workDir,
        workspaceId: testWorkspaceId,
        planMode: true,
        autoAcceptPlan: true,
        fullyAutonomous: true,
      });

      const storedLoop = await loadLoop(loop.config.id);
      expect(storedLoop).not.toBeNull();
      storedLoop!.state.status = "completed";
      storedLoop!.state.planMode = {
        active: false,
        feedbackRounds: 0,
        planningFolderCleared: false,
        isPlanReady: true,
      };
      storedLoop!.state.fullyAutonomousPending = true;
      await saveLoop(storedLoop!);

      const events: LoopEvent[] = [];
      const emitter = new SimpleEventEmitter<LoopEvent>();
      emitter.subscribe((event) => events.push(event));

      const loopCtx: LoopCtx = {
        engines: new Map(),
        emitter,
        loopsBeingAccepted: new Set(),
        stopLoop: async () => {},
        deleteLoop: async () => false,
        discardLoop: async () => ({ success: false, error: "unused" }),
        getLoop: async () => loadLoop(loop.config.id),
        startLoop: async () => {},
        startPlanMode: async () => {},
        acceptPlan: async () => ({ mode: "start_loop" }),
        pushLoop: async () => ({ success: false, error: "Operation already in progress" }),
        startAutomaticPrFlow: async () => ({ success: true }),
        startStatePersistence: () => {},
        ensureLoopBranchCheckedOut: async () => {},
        validateMainCheckoutStart: async () => {},
        clearPlanningFiles: async () => {},
        recoverPlanningEngine: async () => {
          throw new Error("unused");
        },
        startFeedbackCycle: async () => ({ success: false, error: "unused" }),
        jumpstartLoop: async () => ({ success: false, error: "unused" }),
      };

      await handleFullyAutonomousCompletionImpl(loopCtx, loop.config.id);

      const updatedLoop = await loadLoop(loop.config.id);
      expect(updatedLoop?.state.fullyAutonomousPending).toBe(true);
      expect(updatedLoop?.state.automaticPrFlow).toBeUndefined();
      expect(events).toHaveLength(0);
    } finally {
      await teardownTestContext(ctx);
    }
  });
});
