import type { SimpleEventEmitter } from "../event-emitter";
import type { TaskEvent } from "../../types/events";
import type { AutomaticPrFlowState } from "../../types/task";
import { createTimestamp } from "../../types/events";

export function emitAutomaticPrFlowUpdatedEvent(
  emitter: SimpleEventEmitter<TaskEvent>,
  taskId: string,
  automaticPrFlow?: AutomaticPrFlowState,
): void {
  emitter.emit({
    type: "task.automatic_pr_flow.updated",
    taskId,
    automaticPrFlow,
    timestamp: createTimestamp(),
  });
}
