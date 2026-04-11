import type { SimpleEventEmitter } from "../event-emitter";
import type { LoopEvent } from "../../types/events";
import type { AutomaticPrFlowState } from "../../types/loop";
import { createTimestamp } from "../../types/events";

export function emitAutomaticPrFlowUpdatedEvent(
  emitter: SimpleEventEmitter<LoopEvent>,
  loopId: string,
  automaticPrFlow?: AutomaticPrFlowState,
): void {
  emitter.emit({
    type: "loop.automatic_pr_flow.updated",
    loopId,
    automaticPrFlow,
    timestamp: createTimestamp(),
  });
}
