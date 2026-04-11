import { describe, expect, test } from "bun:test";
import { SimpleEventEmitter } from "../../src/core/event-emitter";
import { emitAutomaticPrFlowUpdatedEvent } from "../../src/core/loop/loop-automatic-pr-flow-events";
import type { LoopEvent } from "../../src/types/events";

describe("emitAutomaticPrFlowUpdatedEvent", () => {
  test("emits the persisted automatic PR flow state for subscribers", () => {
    const events: LoopEvent[] = [];
    const emitter = new SimpleEventEmitter<LoopEvent>();
    emitter.subscribe((event) => events.push(event));

    emitAutomaticPrFlowUpdatedEvent(emitter, "loop-1", {
      enabled: true,
      status: "monitoring",
      startedAt: "2026-04-11T04:00:00.000Z",
      updatedAt: "2026-04-11T04:00:00.000Z",
      lastCheckedAt: "2026-04-11T04:00:00.000Z",
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/example/repo/pull/42",
      handledItems: [],
    });

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.type).toBe("loop.automatic_pr_flow.updated");
    if (event?.type === "loop.automatic_pr_flow.updated") {
      expect(event.loopId).toBe("loop-1");
      expect(event.automaticPrFlow?.enabled).toBe(true);
      expect(event.automaticPrFlow?.pullRequestNumber).toBe(42);
      expect(event.timestamp).toBeDefined();
    }
  });
});
