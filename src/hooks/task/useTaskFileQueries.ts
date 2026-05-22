/**
 * Read-only file and metadata queries for the useTask hook.
 * Handles diff, plan, status file, and pull request destination fetches.
 */

import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { FileDiff, FileContentResponse, PullRequestDestinationResponse, Task } from "../../types";
import { createLogger } from "../../lib/logger";
import { appFetch } from "../../lib/public-path";

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

interface ApiErrorBody {
  error?: string;
}

function createEmptyFileContent(): FileContentResponse {
  return {
    content: "",
    exists: false,
  };
}

async function getApiErrorBody(response: Response): Promise<ApiErrorBody | null> {
  try {
    return (await response.json()) as ApiErrorBody;
  } catch {
    return null;
  }
}

function shouldSuppressTransientPlanningFileFetchError(
  taskStatus: Task["state"]["status"] | undefined,
  isPlanReady: boolean | undefined,
  response: Response,
  errorBody: ApiErrorBody | null,
): boolean {
  return (
    taskStatus === "planning"
    && isPlanReady !== true
    && response.status === 400
    && errorBody?.error === "no_worktree"
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
      const response = await appFetch(`/api/tasks/${actionTaskId}/diff`);
      if (!response.ok) {
        // 400 "no_git_branch" is expected when task is in planning mode or hasn't started yet
        if (response.status === 400) {
          return []; // Return empty diff instead of showing error
        }
        throw new Error(`Failed to get diff: ${response.statusText}`);
      }
      const diff = (await response.json()) as FileDiff[];
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
      const response = await appFetch(`/api/tasks/${actionTaskId}/plan`);
      if (!response.ok) {
        const errorBody = await getApiErrorBody(response);
        if (shouldSuppressTransientPlanningFileFetchError(taskStatus, isPlanReady, response, errorBody)) {
          if (!isActiveTask(actionTaskId)) {
            return fallback;
          }
          log.debug("Suppressing transient plan fetch error during planning startup", {
            taskId: actionTaskId,
            status: response.status,
            error: errorBody?.error,
          });
          return fallback;
        }
        throw new Error(`Failed to get plan: ${response.statusText}`);
      }
      const result = (await response.json()) as FileContentResponse;
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
      const response = await appFetch(`/api/tasks/${actionTaskId}/status-file`);
      if (!response.ok) {
        const errorBody = await getApiErrorBody(response);
        if (shouldSuppressTransientPlanningFileFetchError(taskStatus, isPlanReady, response, errorBody)) {
          if (!isActiveTask(actionTaskId)) {
            return fallback;
          }
          log.debug("Suppressing transient status file fetch error during planning startup", {
            taskId: actionTaskId,
            status: response.status,
            error: errorBody?.error,
          });
          return fallback;
        }
        throw new Error(`Failed to get status file: ${response.statusText}`);
      }
      const result = (await response.json()) as FileContentResponse;
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
        const response = await appFetch(`/api/tasks/${actionTaskId}/pull-request`);
        if (!response.ok) {
          throw new Error(`Failed to get pull request destination: ${response.statusText}`);
        }
        const result = (await response.json()) as PullRequestDestinationResponse;
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
