import type { ChatTranscriptPage, Task, ToolCallRecord } from "@/shared";
import {
  getTranscriptMeta,
  listTranscriptEntries,
  getTranscriptToolCall,
} from "../persistence/transcripts/store";
import { loadTaskSummary } from "../persistence/tasks";
import {
  createTranscriptPageFromStorageEntries,
  normalizeTranscriptPageSize,
  parseTranscriptCursor,
} from "./transcript-service";

export type TaskTranscriptSnapshotTask = Omit<Task, "state"> & {
  state: Omit<Task["state"], "messages" | "logs" | "toolCalls">;
};

export interface TaskTranscriptSnapshot {
  task: TaskTranscriptSnapshotTask;
  transcript: ChatTranscriptPage;
}

function createTaskTranscriptPage(
  taskId: string,
  limit: number | undefined,
  before?: string,
): ChatTranscriptPage {
  const meta = getTranscriptMeta("task", taskId);
  if (!meta) {
    throw new Error(`Task transcript metadata is unavailable: ${taskId}`);
  }
  const entries = listTranscriptEntries(
    "task",
    taskId,
    before ? parseTranscriptCursor(before) : undefined,
    limit === undefined ? undefined : limit + 1,
  );
  return createTranscriptPageFromStorageEntries(entries, limit, before, {
    revision: meta.revision,
    totalEntries: meta.entryCount,
  });
}

export async function getTaskTranscriptSnapshot(
  taskId: string,
): Promise<TaskTranscriptSnapshot | null> {
  const task = await loadTaskSummary(taskId);
  if (!task) {
    return null;
  }

  if (!getTranscriptMeta("task", taskId)) {
    throw new Error(`Task transcript metadata is unavailable: ${taskId}`);
  }

  const { messages: _messages, logs: _logs, toolCalls: _toolCalls, ...state } = task.state;
  return {
    task: {
      config: task.config,
      state,
    },
    transcript: createTaskTranscriptPage(taskId, undefined),
  };
}

export async function getTaskTranscriptPage(
  taskId: string,
  limit: number,
  before?: string,
): Promise<ChatTranscriptPage | null> {
  const task = await loadTaskSummary(taskId);
  if (!task) {
    return null;
  }
  if (!getTranscriptMeta("task", taskId)) {
    throw new Error(`Task transcript metadata is unavailable: ${taskId}`);
  }
  return createTaskTranscriptPage(taskId, limit, before);
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

export { normalizeTranscriptPageSize };
