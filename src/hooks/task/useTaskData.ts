import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type {
  ChatTranscript,
  Task,
  ToolCallData,
} from "@/shared";
import {
  useTranscriptResource,
} from "../useTranscriptResource";

interface TaskSnapshotResponse {
  task: Task;
  transcript: ChatTranscript;
}

export interface UseTaskDataResult {
  task: Task | null;
  setTask: Dispatch<SetStateAction<Task | null>>;
  transcript: ChatTranscript;
  loading: boolean;
  loadingTranscript: boolean;
  hasOlderTranscript: boolean;
  error: string | null;
  notFound: boolean;
  setError: Dispatch<SetStateAction<string | null>>;
  gitChangeCounter: number;
  setGitChangeCounter: Dispatch<SetStateAction<number>>;
  refresh: () => Promise<void>;
  loadToolDetails: (toolCallId: string) => Promise<ToolCallData | null>;
  loadMoreTranscript: () => Promise<void>;
  loadFullTranscript: () => Promise<void>;
}

function decodeTaskSnapshot(
  snapshot: TaskSnapshotResponse,
): { resource: Task; transcript: ChatTranscript } {
  return {
    resource: {
      ...snapshot.task,
      state: {
        ...snapshot.task.state,
        messages: [],
        logs: [],
        toolCalls: [],
      },
    },
    transcript: snapshot.transcript,
  };
}

export function useTaskData(taskId: string): UseTaskDataResult {
  const transcriptResource = useTranscriptResource<Task, TaskSnapshotResponse>({
    resourceId: taskId,
    resourceLabel: "task",
    stream: "task",
    baseUrl: `/api/tasks/${encodeURIComponent(taskId)}`,
    decodeSnapshot: decodeTaskSnapshot,
  });
  const [gitChangeCounter, setGitChangeCounter] = useState(0);
  useEffect(() => {
    setGitChangeCounter(0);
  }, [taskId]);

  return {
    task: transcriptResource.resource,
    setTask: transcriptResource.setResource,
    transcript: transcriptResource.transcript,
    loading: transcriptResource.loading,
    loadingTranscript: transcriptResource.loadingTranscript,
    hasOlderTranscript: transcriptResource.transcript.hasOlder,
    error: transcriptResource.error,
    notFound: transcriptResource.notFound,
    setError: transcriptResource.setError,
    gitChangeCounter,
    setGitChangeCounter,
    refresh: transcriptResource.refresh,
    loadToolDetails: transcriptResource.loadToolDetails,
    loadMoreTranscript: transcriptResource.loadMoreTranscript,
    loadFullTranscript: transcriptResource.loadFullTranscript,
  };
}
