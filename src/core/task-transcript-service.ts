import type { ChatTranscript, Task, ToolCallRecord } from "@/shared";
import {
  getTranscriptMeta,
  listTranscriptEntries,
  getTranscriptToolCall,
} from "../persistence/transcripts/store";
import { loadTaskSummary } from "../persistence/tasks";
import { createTranscriptFromStorageEntries } from "./transcript-service";

export type TaskTranscriptSnapshotTask = Omit<Task, "state"> & {
  state: Omit<Task["state"], "messages" | "logs" | "toolCalls">;
};

export interface TaskTranscriptSnapshot {
  task: TaskTranscriptSnapshotTask;
  transcript: ChatTranscript;
}

export async function getTaskTranscriptSnapshot(
  taskId: string,
): Promise<TaskTranscriptSnapshot | null> {
  const task = await loadTaskSummary(taskId);
  if (!task) {
    return null;
  }

  const meta = getTranscriptMeta("task", taskId);
  if (!meta) {
    throw new Error(`Task transcript metadata is unavailable: ${taskId}`);
  }

  const { messages: _messages, logs: _logs, toolCalls: _toolCalls, ...state } = task.state;
  return {
    task: {
      config: task.config,
      state,
    },
    transcript: createTranscriptFromStorageEntries(
      listTranscriptEntries("task", taskId),
      {
        revision: meta.revision,
        totalEntries: meta.entryCount,
      },
    ),
  };
}

export async function getTaskTranscriptToolCall(
  taskId: string,
  toolCallId: string,
): Promise<ToolCallRecord | null> {
  const task = await loadTaskSummary(taskId);
  if (!task) {
    return null;
  }
  if (!getTranscriptMeta("task", taskId)) {
    throw new Error(`Task transcript metadata is unavailable: ${taskId}`);
  }
  return getTranscriptToolCall("task", taskId, toolCallId);
}
