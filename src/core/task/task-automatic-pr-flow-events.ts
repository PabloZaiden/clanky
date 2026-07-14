import type { SimpleEventEmitter } from "../event-emitter";
import type { TaskEvent } from "@/shared/events";
import type { AutomaticPrFlowState } from "@/shared/task";
import { createTimestamp } from "@/shared/events";

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
