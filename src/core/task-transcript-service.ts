import type {
  ChatTranscript,
  Task,
  ToolCallRecord,
  TranscriptSnapshotOptions,
} from "@/shared";
import { shouldIncludeConversationTranscriptLog } from "@/shared";
import { taskTranscriptStore } from "../persistence/transcripts/task-store";
import { loadTaskSummary } from "../persistence/tasks";
import { createTranscriptFromStoragePage } from "./transcript-service";

export type TaskTranscriptSnapshotTask = Omit<Task, "state"> & {
  state: Omit<Task["state"], "messages" | "logs" | "toolCalls">;
};

export interface TaskTranscriptSnapshot {
  task: TaskTranscriptSnapshotTask;
  transcript: ChatTranscript;
}

export async function getTaskTranscriptSnapshot(
  taskId: string,
  options: TranscriptSnapshotOptions = {},
): Promise<TaskTranscriptSnapshot | null> {
  const task = await loadTaskSummary(taskId);
  if (!task) {
    return null;
  }

  const meta = taskTranscriptStore.getMeta(taskId);
  if (!meta) {
    throw new Error(`Task transcript metadata is unavailable: ${taskId}`);
  }

  const { messages: _messages, logs: _logs, toolCalls: _toolCalls, ...state } = task.state;
  return {
    task: {
      config: task.config,
      state,
    },
    transcript: createTranscriptFromStoragePage(
      taskTranscriptStore.listPage(taskId, options),
      {
        revision: meta.revision,
        totalEntries: meta.entryCount,
      },
      shouldIncludeConversationTranscriptLog,
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
  if (!taskTranscriptStore.getMeta(taskId)) {
    throw new Error(`Task transcript metadata is unavailable: ${taskId}`);
  }
  return taskTranscriptStore.getToolCall(taskId, toolCallId);
}
