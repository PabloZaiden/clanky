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
import { requireCurrentUserId } from "../context/user-context";
import { isPersistedMessage } from "../persistence/transcripts/codec";
import { DomainError } from "../domain/domain-error";
import type { PersistedMessage } from "@/shared";
import type { TranscriptStorageCursor } from "../persistence/transcripts/types";

export async function* iterateTaskAttachmentMessages(taskId: string): AsyncIterable<PersistedMessage> {
  const userId = requireCurrentUserId();
  let after: TranscriptStorageCursor | undefined;
  for (;;) {
    const page = taskTranscriptStore.listEntriesAfterForUser(taskId, userId, {
      after, limit: 4, includeToolPayload: false, fileAttachmentsOnly: true,
    });
    if (page.invalidEntryCount > 0) {
      throw new DomainError("attachment_data_invalid", "The saved task transcript contains unreadable entries.");
    }
    while (page.entries.length) {
      const entry = page.entries.shift()!;
      if (entry.kind !== "message") continue;
      if (!isPersistedMessage(entry.payload)) {
        throw new DomainError("attachment_data_invalid", "A saved task message's attachments could not be restored.");
      }
      yield entry.payload;
    }
    if (!page.nextCursor) return;
    after = page.nextCursor;
  }
}

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
