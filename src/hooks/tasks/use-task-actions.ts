/**
 * Task lifecycle actions: accept, push, discard, purge, address review comments.
 */

import { useCallback } from "react";
import type { Task } from "@/shared";
import type { MessageImageAttachment } from "@/shared/message-attachments";
import {
  acceptTaskApi,
  pushTaskApi,
  discardTaskApi,
  purgeTaskApi,
  purgeArchivedWorkspaceTasksApi,
  addressReviewCommentsApi,
  type AcceptTaskResult,
  type PushTaskResult,
  type AddressCommentsResult,
  type PurgeArchivedTasksResult,
} from "../taskActions";
import { updateBranchApi } from "../taskActions";

interface UseTaskActionsOptions {
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  refreshTask: (id: string) => Promise<void>;
}

export interface UseTaskActionsResult {
  acceptTask: (id: string) => Promise<AcceptTaskResult>;
  pushTask: (id: string) => Promise<PushTaskResult>;
  updateBranch: (id: string) => Promise<PushTaskResult>;
  discardTask: (id: string) => Promise<boolean>;
  purgeTask: (id: string) => Promise<boolean>;
  purgeArchivedWorkspaceTasks: (workspaceId: string) => Promise<PurgeArchivedTasksResult>;
  addressReviewComments: (id: string, comments: string, attachments?: MessageImageAttachment[]) => Promise<AddressCommentsResult>;
}

export function useTaskActions({ setError, setTasks, refreshTask }: UseTaskActionsOptions): UseTaskActionsResult {
  const acceptTask = useCallback(async (id: string): Promise<AcceptTaskResult> => {
    try {
      const result = await acceptTaskApi(id);
      await refreshTask(id);
      return result;
    } catch (err) {
      setError(String(err));
      return { success: false };
    }
  }, [refreshTask, setError]);

  const pushTask = useCallback(async (id: string): Promise<PushTaskResult> => {
    try {
      const result = await pushTaskApi(id);
      await refreshTask(id);
      return result;
    } catch (err) {
      setError(String(err));
      return { success: false };
    }
  }, [refreshTask, setError]);

  const updateBranch = useCallback(async (id: string): Promise<PushTaskResult> => {
    try {
      const result = await updateBranchApi(id);
      await refreshTask(id);
      return result;
    } catch (err) {
      setError(String(err));
      return { success: false };
    }
  }, [refreshTask, setError]);

  const discardTask = useCallback(async (id: string): Promise<boolean> => {
    try {
      await discardTaskApi(id);
      await refreshTask(id);
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    }
  }, [refreshTask, setError]);

  const purgeTask = useCallback(async (id: string): Promise<boolean> => {
    try {
      await purgeTaskApi(id);
      // Remove from state immediately since purge doesn't emit a WebSocket event
      // (archived tasks are removed from the system entirely)
      setTasks((prev) => prev.filter((l) => l.config.id !== id));
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    }
  }, [setError, setTasks]);

  const purgeArchivedWorkspaceTasks = useCallback(async (workspaceId: string): Promise<PurgeArchivedTasksResult> => {
    try {
      const result = await purgeArchivedWorkspaceTasksApi(workspaceId);
      const purgedTaskIds = new Set(result.purgedTaskIds);
      setTasks((prev) => prev.filter((task) => !purgedTaskIds.has(task.config.id)));
      return result;
    } catch (err) {
      const message = String(err);
      setError(message);
      return {
        success: false,
        workspaceId,
        totalArchived: 0,
        purgedCount: 0,
        purgedTaskIds: [],
        failures: [],
      };
    }
  }, [setError, setTasks]);

  const addressReviewComments = useCallback(async (
    id: string,
    comments: string,
    attachments?: MessageImageAttachment[],
  ): Promise<AddressCommentsResult> => {
    try {
      const result = await addressReviewCommentsApi(id, comments, attachments);
      await refreshTask(id);
      return result;
    } catch (err) {
      setError(String(err));
      return { success: false };
    }
  }, [refreshTask, setError]);

  return {
    acceptTask,
    pushTask,
    updateBranch,
    discardTask,
    purgeTask,
    purgeArchivedWorkspaceTasks,
    addressReviewComments,
  };
}
