/**
 * Read-only file and metadata queries for the useTask hook.
 * Handles diff, plan, status file, and pull request destination fetches.
 */

import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Task } from "@/shared";
import type { FileDiff, FileContentResponse, PullRequestDestinationResponse } from "@/contracts";
import { createLogger } from "@pablozaiden/webapp/web";
import { ApiError, parseApiError } from "../../lib/api-error";
import { apiRequest, readApiResponse, requestApiResponse } from "../../lib/api-client";

const log = createLogger("useTask");

export interface UseTaskFileQueriesParams {
  taskId: string;
  task: Task | null;
  isActiveTask: (expectedTaskId: string) => boolean;
  ignoreStaleTaskAction: <T>(actionName: string, expectedTaskId: string, fallback: T) => T | null;
  ignoreStaleTaskError: <T>(
    actionName: string,
    expectedTaskId: string,
    fallback: T,
    error: unknown,
  ) => T | null;
  setError: Dispatch<SetStateAction<string | null>>;
}

function createEmptyFileContent(): FileContentResponse {
  return {
    content: "",
    exists: false,
  };
}

function shouldSuppressTransientPlanningFileFetchError(
  taskStatus: Task["state"]["status"] | undefined,
  isPlanReady: boolean | undefined,
  error: unknown,
): boolean {
  return (
    taskStatus === "planning"
    && isPlanReady !== true
    && error instanceof ApiError
    && error.status === 400
    && error.code === "no_worktree"
  );
}

export interface UseTaskFileQueriesResult {
  getDiff: () => Promise<FileDiff[]>;
  getPlan: () => Promise<FileContentResponse>;
  getStatusFile: () => Promise<FileContentResponse>;
  getPullRequestDestination: () => Promise<PullRequestDestinationResponse>;
}

export function useTaskFileQueries(params: UseTaskFileQueriesParams): UseTaskFileQueriesResult {
  const { taskId, task, isActiveTask, ignoreStaleTaskAction, ignoreStaleTaskError, setError } = params;
  const taskStatus = task?.state.status;
  const isPlanReady = task?.state.planMode?.isPlanReady;

  const getDiff = useCallback(async (): Promise<FileDiff[]> => {
    const actionTaskId = taskId;
    const staleAction = ignoreStaleTaskAction("getDiff", actionTaskId, [] as FileDiff[]);
    if (staleAction !== null) {
      return staleAction;
    }
    log.debug("Getting diff", { taskId: actionTaskId });
    try {
      const response = await requestApiResponse(`/api/tasks/${actionTaskId}/diff`, {
        action: "Get task diff",
        fallbackMessage: "Failed to get diff",
        acceptedStatuses: [400],
      });
      // 400 "no_git_branch" is expected when task is in planning mode or has not started yet.
      if (response.status === 400) {
        return [];
      }
      const diff = await readApiResponse<FileDiff[]>(response);
      if (!isActiveTask(actionTaskId)) {
        return [];
      }
      log.debug("Diff retrieved", { taskId: actionTaskId, fileCount: diff.length });
      return diff;
    } catch (err) {
      const staleError = ignoreStaleTaskError("getDiff", actionTaskId, [] as FileDiff[], err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to get diff", { taskId: actionTaskId, error: String(err) });
      setError(String(err));
      return [];
    }
  }, [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, setError]);

  const getPlan = useCallback(async (): Promise<FileContentResponse> => {
    const actionTaskId = taskId;
    const fallback = createEmptyFileContent();
    const staleAction = ignoreStaleTaskAction("getPlan", actionTaskId, fallback);
    if (staleAction !== null) {
      return staleAction;
    }
    log.debug("Getting plan", { taskId: actionTaskId });
    try {
      const response = await requestApiResponse(`/api/tasks/${actionTaskId}/plan`, {
        action: "Get task plan",
        fallbackMessage: "Failed to get plan",
        acceptedStatuses: [400],
      });
      if (response.status === 400) {
        const error = await parseApiError(response, "Failed to get plan");
        if (shouldSuppressTransientPlanningFileFetchError(taskStatus, isPlanReady, error)) {
          if (!isActiveTask(actionTaskId)) {
            return fallback;
          }
          log.debug("Suppressing transient plan fetch error during planning startup", {
            taskId: actionTaskId,
            status: error.status,
            error: error.code,
          });
          return fallback;
        }
        throw error;
      }
      const result = await readApiResponse<FileContentResponse>(response);
      if (!isActiveTask(actionTaskId)) {
        return fallback;
      }
      return result;
    } catch (err) {
      const staleError = ignoreStaleTaskError(
        "getPlan",
        actionTaskId,
        fallback,
        err,
      );
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to get plan", { taskId: actionTaskId, error: String(err) });
      setError(String(err));
      return fallback;
    }
  }, [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, isPlanReady, taskId, taskStatus, setError]);

  const getStatusFile = useCallback(async (): Promise<FileContentResponse> => {
    const actionTaskId = taskId;
    const fallback = createEmptyFileContent();
    const staleAction = ignoreStaleTaskAction("getStatusFile", actionTaskId, fallback);
    if (staleAction !== null) {
      return staleAction;
    }
    log.debug("Getting status file", { taskId: actionTaskId });
    try {
      const response = await requestApiResponse(`/api/tasks/${actionTaskId}/status-file`, {
        action: "Get task status file",
        fallbackMessage: "Failed to get status file",
        acceptedStatuses: [400],
      });
      if (response.status === 400) {
        const error = await parseApiError(response, "Failed to get status file");
        if (shouldSuppressTransientPlanningFileFetchError(taskStatus, isPlanReady, error)) {
          if (!isActiveTask(actionTaskId)) {
            return fallback;
          }
          log.debug("Suppressing transient status file fetch error during planning startup", {
            taskId: actionTaskId,
            status: error.status,
            error: error.code,
          });
          return fallback;
        }
        throw error;
      }
      const result = await readApiResponse<FileContentResponse>(response);
      if (!isActiveTask(actionTaskId)) {
        return fallback;
      }
      return result;
    } catch (err) {
      const staleError = ignoreStaleTaskError(
        "getStatusFile",
        actionTaskId,
        fallback,
        err,
      );
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to get status file", { taskId: actionTaskId, error: String(err) });
      setError(String(err));
      return fallback;
    }
  }, [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, isPlanReady, taskId, taskStatus, setError]);

  const getPullRequestDestination = useCallback(
    async (): Promise<PullRequestDestinationResponse> => {
      const actionTaskId = taskId;
      const fallback: PullRequestDestinationResponse = {
        enabled: false,
        destinationType: "disabled",
        disabledReason: "Failed to load pull request information.",
      };
      const staleAction = ignoreStaleTaskAction(
        "getPullRequestDestination",
        actionTaskId,
        fallback,
      );
      if (staleAction !== null) {
        return staleAction;
      }
      log.debug("Getting pull request destination", { taskId: actionTaskId });
      try {
        const result = await apiRequest<PullRequestDestinationResponse>(
          `/api/tasks/${actionTaskId}/pull-request`,
          {
            action: "Get pull request destination",
            fallbackMessage: "Failed to get pull request destination",
          },
        );
        if (!isActiveTask(actionTaskId)) {
          return fallback;
        }
        return result;
      } catch (err) {
        const staleError = ignoreStaleTaskError(
          "getPullRequestDestination",
          actionTaskId,
          fallback,
          err,
        );
        if (staleError !== null) {
          return staleError;
        }
        log.error("Failed to get pull request destination", {
          taskId: actionTaskId,
          error: String(err),
        });
        return fallback;
      }
    },
    [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId],
  );

  return { getDiff, getPlan, getStatusFile, getPullRequestDestination };
}
