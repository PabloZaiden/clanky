/**
 * Task lifecycle actions for the useTask hook.
 * Handles CRUD and state-transition operations: update, remove, stop, discard, purge, markMerged, closeLocalTask, manualCompleteTask.
 */

import { useCallback } from "react";
import {
  deleteTaskApi,
  stopTaskApi,
  discardTaskApi,
  purgeTaskApi,
  markMergedApi,
  closeLocalTaskApi,
  manualCompleteTaskApi,
} from "../taskActions";
import { createLogger } from "../../lib/logger";
import { appFetch } from "../../lib/public-path";
import type { Task } from "@/shared";
import type { UpdateTaskRequest } from "@/contracts";
import type { UseTaskActionsParams } from "./useTaskActions";

const log = createLogger("useTask");

export interface UseTaskLifecycleActionsResult {
  update: (request: UpdateTaskRequest) => Promise<boolean>;
  remove: () => Promise<boolean>;
  stopTask: () => Promise<boolean>;
  discard: () => Promise<boolean>;
  purge: () => Promise<boolean>;
  markMerged: () => Promise<boolean>;
  closeLocalTask: () => Promise<boolean>;
  manualCompleteTask: () => Promise<boolean>;
}

export function useTaskLifecycleActions(
  params: UseTaskActionsParams,
): UseTaskLifecycleActionsResult {
  const {
    taskId,
    isActiveTask,
    ignoreStaleTaskAction,
    ignoreStaleTaskError,
    setTask,
    setError,
    refresh,
  } = params;

  const update = useCallback(
    async (request: UpdateTaskRequest): Promise<boolean> => {
      const actionTaskId = taskId;
      const staleAction = ignoreStaleTaskAction("update", actionTaskId, false);
      if (staleAction !== null) {
        return staleAction;
      }
      log.info("Updating task", {
        taskId: actionTaskId,
        hasNameUpdate: request.name !== undefined,
      });
      try {
        const response = await appFetch(`/api/tasks/${actionTaskId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.message || "Failed to update task");
        }
        const data = (await response.json()) as Task;
        if (!isActiveTask(actionTaskId)) {
          return false;
        }
        setTask(data);
        log.info("Task updated successfully", { taskId: actionTaskId });
        return true;
      } catch (err) {
        const staleError = ignoreStaleTaskError("update", actionTaskId, false, err);
        if (staleError !== null) {
          return staleError;
        }
        log.error("Failed to update task", { taskId: actionTaskId, error: String(err) });
        setError(String(err));
        return false;
      }
    },
    [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, setError, setTask],
  );

  const remove = useCallback(async (): Promise<boolean> => {
    const actionTaskId = taskId;
    const staleAction = ignoreStaleTaskAction("remove", actionTaskId, false);
    if (staleAction !== null) {
      return staleAction;
    }
    log.info("Deleting task", { taskId: actionTaskId });
    try {
      await deleteTaskApi(actionTaskId);
      if (!isActiveTask(actionTaskId)) {
        return false;
      }
      setTask(null);
      log.info("Task deleted", { taskId: actionTaskId });
      return true;
    } catch (err) {
      const staleError = ignoreStaleTaskError("remove", actionTaskId, false, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to delete task", { taskId: actionTaskId, error: String(err) });
      setError(String(err));
      return false;
    }
  }, [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, refresh, setError, setTask]);

  const stopTask = useCallback(async (): Promise<boolean> => {
    const actionTaskId = taskId;
    const staleAction = ignoreStaleTaskAction("stopTask", actionTaskId, false);
    if (staleAction !== null) {
      return staleAction;
    }
    log.info("Stopping task", { taskId: actionTaskId });
    try {
      await stopTaskApi(actionTaskId);
      await refresh();
      if (!isActiveTask(actionTaskId)) {
        return false;
      }
      log.info("Task stopped", { taskId: actionTaskId });
      return true;
    } catch (err) {
      const staleError = ignoreStaleTaskError("stopTask", actionTaskId, false, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to stop task", { taskId: actionTaskId, error: String(err) });
      setError(String(err));
      return false;
    }
  }, [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, refresh, setError]);

  const discard = useCallback(async (): Promise<boolean> => {
    const actionTaskId = taskId;
    const staleAction = ignoreStaleTaskAction("discard", actionTaskId, false);
    if (staleAction !== null) {
      return staleAction;
    }
    log.info("Discarding task", { taskId: actionTaskId });
    try {
      await discardTaskApi(actionTaskId);
      await refresh();
      if (!isActiveTask(actionTaskId)) {
        return false;
      }
      log.info("Task discarded", { taskId: actionTaskId });
      return true;
    } catch (err) {
      const staleError = ignoreStaleTaskError("discard", actionTaskId, false, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to discard task", { taskId: actionTaskId, error: String(err) });
      setError(String(err));
      return false;
    }
  }, [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, refresh, setError]);

  const purge = useCallback(async (): Promise<boolean> => {
    const actionTaskId = taskId;
    const staleAction = ignoreStaleTaskAction("purge", actionTaskId, false);
    if (staleAction !== null) {
      return staleAction;
    }
    log.info("Purging task", { taskId: actionTaskId });
    try {
      await purgeTaskApi(actionTaskId);
      if (!isActiveTask(actionTaskId)) {
        return false;
      }
      setTask(null);
      log.info("Task purged", { taskId: actionTaskId });
      return true;
    } catch (err) {
      const staleError = ignoreStaleTaskError("purge", actionTaskId, false, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to purge task", { taskId: actionTaskId, error: String(err) });
      setError(String(err));
      return false;
    }
  }, [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, refresh, setError, setTask]);

  const markMerged = useCallback(async (): Promise<boolean> => {
    const actionTaskId = taskId;
    const staleAction = ignoreStaleTaskAction("markMerged", actionTaskId, false);
    if (staleAction !== null) {
      return staleAction;
    }
    log.info("Marking task as merged", { taskId: actionTaskId });
    try {
      await markMergedApi(actionTaskId);
      await refresh();
      if (!isActiveTask(actionTaskId)) {
        return false;
      }
      log.info("Task marked as merged", { taskId: actionTaskId });
      return true;
    } catch (err) {
      const staleError = ignoreStaleTaskError("markMerged", actionTaskId, false, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to mark task as merged", { taskId: actionTaskId, error: String(err) });
      setError(String(err));
      return false;
    }
  }, [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, refresh, setError]);

  const closeLocalTask = useCallback(async (): Promise<boolean> => {
    const actionTaskId = taskId;
    const staleAction = ignoreStaleTaskAction("closeLocalTask", actionTaskId, false);
    if (staleAction !== null) {
      return staleAction;
    }
    log.info("Closing locally accepted task", { taskId: actionTaskId });
    try {
      await closeLocalTaskApi(actionTaskId);
      await refresh();
      if (!isActiveTask(actionTaskId)) {
        return false;
      }
      log.info("Locally accepted task closed", { taskId: actionTaskId });
      return true;
    } catch (err) {
      const staleError = ignoreStaleTaskError("closeLocalTask", actionTaskId, false, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to close locally accepted task", { taskId: actionTaskId, error: String(err) });
      setError(String(err));
      return false;
    }
  }, [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, refresh, setError]);

  const manualCompleteTask = useCallback(async (): Promise<boolean> => {
    const actionTaskId = taskId;
    const staleAction = ignoreStaleTaskAction("manualCompleteTask", actionTaskId, false);
    if (staleAction !== null) {
      return staleAction;
    }
    log.info("Manually completing task", { taskId: actionTaskId });
    try {
      await manualCompleteTaskApi(actionTaskId);
      await refresh();
      if (!isActiveTask(actionTaskId)) {
        return false;
      }
      log.info("Task manually completed", { taskId: actionTaskId });
      return true;
    } catch (err) {
      const staleError = ignoreStaleTaskError("manualCompleteTask", actionTaskId, false, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to manually complete task", { taskId: actionTaskId, error: String(err) });
      setError(String(err));
      return false;
    }
  }, [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, refresh, setError]);

  return { update, remove, stopTask, discard, purge, markMerged, closeLocalTask, manualCompleteTask };
}
