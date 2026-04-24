/**
 * Read-only file and metadata queries for the useLoop hook.
 * Handles diff, plan, status file, and pull request destination fetches.
 */

import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { FileDiff, FileContentResponse, PullRequestDestinationResponse, Loop } from "../../types";
import { createLogger } from "../../lib/logger";
import { appFetch } from "../../lib/public-path";

const log = createLogger("useLoop");

export interface UseLoopFileQueriesParams {
  loopId: string;
  loop: Loop | null;
  isActiveLoop: (expectedLoopId: string) => boolean;
  ignoreStaleLoopAction: <T>(actionName: string, expectedLoopId: string, fallback: T) => T | null;
  ignoreStaleLoopError: <T>(
    actionName: string,
    expectedLoopId: string,
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
  loopStatus: Loop["state"]["status"] | undefined,
  isPlanReady: boolean | undefined,
  response: Response,
  errorBody: ApiErrorBody | null,
): boolean {
  return (
    loopStatus === "planning"
    && isPlanReady !== true
    && response.status === 400
    && errorBody?.error === "no_worktree"
  );
}

export interface UseLoopFileQueriesResult {
  getDiff: () => Promise<FileDiff[]>;
  getPlan: () => Promise<FileContentResponse>;
  getStatusFile: () => Promise<FileContentResponse>;
  getPullRequestDestination: () => Promise<PullRequestDestinationResponse>;
}

export function useLoopFileQueries(params: UseLoopFileQueriesParams): UseLoopFileQueriesResult {
  const { loopId, loop, isActiveLoop, ignoreStaleLoopAction, ignoreStaleLoopError, setError } = params;
  const loopStatus = loop?.state.status;
  const isPlanReady = loop?.state.planMode?.isPlanReady;

  const getDiff = useCallback(async (): Promise<FileDiff[]> => {
    const actionLoopId = loopId;
    const staleAction = ignoreStaleLoopAction("getDiff", actionLoopId, [] as FileDiff[]);
    if (staleAction !== null) {
      return staleAction;
    }
    log.debug("Getting diff", { loopId: actionLoopId });
    try {
      const response = await appFetch(`/api/loops/${actionLoopId}/diff`);
      if (!response.ok) {
        // 400 "no_git_branch" is expected when loop is in planning mode or hasn't started yet
        if (response.status === 400) {
          return []; // Return empty diff instead of showing error
        }
        throw new Error(`Failed to get diff: ${response.statusText}`);
      }
      const diff = (await response.json()) as FileDiff[];
      if (!isActiveLoop(actionLoopId)) {
        return [];
      }
      log.debug("Diff retrieved", { loopId: actionLoopId, fileCount: diff.length });
      return diff;
    } catch (err) {
      const staleError = ignoreStaleLoopError("getDiff", actionLoopId, [] as FileDiff[], err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to get diff", { loopId: actionLoopId, error: String(err) });
      setError(String(err));
      return [];
    }
  }, [ignoreStaleLoopAction, ignoreStaleLoopError, isActiveLoop, loopId, setError]);

  const getPlan = useCallback(async (): Promise<FileContentResponse> => {
    const actionLoopId = loopId;
    const fallback = createEmptyFileContent();
    const staleAction = ignoreStaleLoopAction("getPlan", actionLoopId, fallback);
    if (staleAction !== null) {
      return staleAction;
    }
    log.debug("Getting plan", { loopId: actionLoopId });
    try {
      const response = await appFetch(`/api/loops/${actionLoopId}/plan`);
      if (!response.ok) {
        const errorBody = await getApiErrorBody(response);
        if (shouldSuppressTransientPlanningFileFetchError(loopStatus, isPlanReady, response, errorBody)) {
          if (!isActiveLoop(actionLoopId)) {
            return fallback;
          }
          log.debug("Suppressing transient plan fetch error during planning startup", {
            loopId: actionLoopId,
            status: response.status,
            error: errorBody?.error,
          });
          return fallback;
        }
        throw new Error(`Failed to get plan: ${response.statusText}`);
      }
      const result = (await response.json()) as FileContentResponse;
      if (!isActiveLoop(actionLoopId)) {
        return fallback;
      }
      return result;
    } catch (err) {
      const staleError = ignoreStaleLoopError(
        "getPlan",
        actionLoopId,
        fallback,
        err,
      );
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to get plan", { loopId: actionLoopId, error: String(err) });
      setError(String(err));
      return fallback;
    }
  }, [ignoreStaleLoopAction, ignoreStaleLoopError, isActiveLoop, isPlanReady, loopId, loopStatus, setError]);

  const getStatusFile = useCallback(async (): Promise<FileContentResponse> => {
    const actionLoopId = loopId;
    const fallback = createEmptyFileContent();
    const staleAction = ignoreStaleLoopAction("getStatusFile", actionLoopId, fallback);
    if (staleAction !== null) {
      return staleAction;
    }
    log.debug("Getting status file", { loopId: actionLoopId });
    try {
      const response = await appFetch(`/api/loops/${actionLoopId}/status-file`);
      if (!response.ok) {
        const errorBody = await getApiErrorBody(response);
        if (shouldSuppressTransientPlanningFileFetchError(loopStatus, isPlanReady, response, errorBody)) {
          if (!isActiveLoop(actionLoopId)) {
            return fallback;
          }
          log.debug("Suppressing transient status file fetch error during planning startup", {
            loopId: actionLoopId,
            status: response.status,
            error: errorBody?.error,
          });
          return fallback;
        }
        throw new Error(`Failed to get status file: ${response.statusText}`);
      }
      const result = (await response.json()) as FileContentResponse;
      if (!isActiveLoop(actionLoopId)) {
        return fallback;
      }
      return result;
    } catch (err) {
      const staleError = ignoreStaleLoopError(
        "getStatusFile",
        actionLoopId,
        fallback,
        err,
      );
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to get status file", { loopId: actionLoopId, error: String(err) });
      setError(String(err));
      return fallback;
    }
  }, [ignoreStaleLoopAction, ignoreStaleLoopError, isActiveLoop, isPlanReady, loopId, loopStatus, setError]);

  const getPullRequestDestination = useCallback(
    async (): Promise<PullRequestDestinationResponse> => {
      const actionLoopId = loopId;
      const fallback: PullRequestDestinationResponse = {
        enabled: false,
        destinationType: "disabled",
        disabledReason: "Failed to load pull request information.",
      };
      const staleAction = ignoreStaleLoopAction(
        "getPullRequestDestination",
        actionLoopId,
        fallback,
      );
      if (staleAction !== null) {
        return staleAction;
      }
      log.debug("Getting pull request destination", { loopId: actionLoopId });
      try {
        const response = await appFetch(`/api/loops/${actionLoopId}/pull-request`);
        if (!response.ok) {
          throw new Error(`Failed to get pull request destination: ${response.statusText}`);
        }
        const result = (await response.json()) as PullRequestDestinationResponse;
        if (!isActiveLoop(actionLoopId)) {
          return fallback;
        }
        return result;
      } catch (err) {
        const staleError = ignoreStaleLoopError(
          "getPullRequestDestination",
          actionLoopId,
          fallback,
          err,
        );
        if (staleError !== null) {
          return staleError;
        }
        log.error("Failed to get pull request destination", {
          loopId: actionLoopId,
          error: String(err),
        });
        return fallback;
      }
    },
    [ignoreStaleLoopAction, ignoreStaleLoopError, isActiveLoop, loopId],
  );

  return { getDiff, getPlan, getStatusFile, getPullRequestDestination };
}
