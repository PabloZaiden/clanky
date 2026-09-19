import type { Dispatch, SetStateAction } from "react";
import type { TaskEvent, TranscriptStreamEvent } from "@/shared";
import { createLogger } from "@pablozaiden/webapp/web";
import { toTranscriptStreamEvent } from "../transcript-event-adapter";

const log = createLogger("useTask");

export interface TaskEventHandlerParams {
  isActiveTask: (expectedTaskId: string) => boolean;
  applyTranscriptEvent: (event: TranscriptStreamEvent) => void;
  setGitChangeCounter: Dispatch<SetStateAction<number>>;
}

export function createTaskEventHandler({
  isActiveTask,
  applyTranscriptEvent,
  setGitChangeCounter,
}: TaskEventHandlerParams) {
  return function handleEvent(event: TaskEvent): void {
    if (!isActiveTask(event.taskId)) {
      log.trace("Ignoring event for inactive task", {
        type: event.type,
        eventTaskId: event.taskId,
      });
      return;
    }

    const transcriptEvent = toTranscriptStreamEvent(event);
    if (transcriptEvent) {
      applyTranscriptEvent(transcriptEvent);
    }

    if (event.type === "task.iteration.end" || event.type === "task.git.commit") {
      setGitChangeCounter((current) => current + 1);
    }
  };
}
