/**
 * Stale-request guard for the useTask hook.
 * Prevents state updates from in-flight requests that belong to a previous taskId.
 */

import { useCallback, useRef } from "react";
import { createLogger } from "@pablozaiden/webapp/web";

const log = createLogger("useTask");

export interface UseTaskStaleGuardResult {
  activeTaskIdRef: React.MutableRefObject<string>;
  isActiveTask: (expectedTaskId: string) => boolean;
  ignoreStaleTaskAction: <T>(actionName: string, expectedTaskId: string, fallback: T) => T | null;
  ignoreStaleTaskError: <T>(
    actionName: string,
    expectedTaskId: string,
    fallback: T,
    error: unknown,
  ) => T | null;
}

export function useTaskStaleGuard(taskId: string): UseTaskStaleGuardResult {
  const activeTaskIdRef = useRef(taskId);
  activeTaskIdRef.current = taskId;

  const isActiveTask = useCallback((expectedTaskId: string): boolean => {
    return activeTaskIdRef.current === expectedTaskId;
  }, []);

  const ignoreStaleTaskAction = useCallback(
    <T,>(actionName: string, expectedTaskId: string, fallback: T): T | null => {
      if (isActiveTask(expectedTaskId)) {
        return null;
      }
      log.debug("Ignoring stale task action", {
        actionName,
        expectedTaskId,
        activeTaskId: activeTaskIdRef.current,
      });
      return fallback;
    },
    [isActiveTask],
  );

  const ignoreStaleTaskError = useCallback(
    <T,>(
      actionName: string,
      expectedTaskId: string,
      fallback: T,
      error: unknown,
    ): T | null => {
      if (isActiveTask(expectedTaskId)) {
        return null;
      }
      log.debug("Ignoring stale task action error", {
        actionName,
        expectedTaskId,
        activeTaskId: activeTaskIdRef.current,
        error: String(error),
      });
      return fallback;
    },
    [isActiveTask],
  );

  return { activeTaskIdRef, isActiveTask, ignoreStaleTaskAction, ignoreStaleTaskError };
}
