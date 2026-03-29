/**
 * Loop lifecycle actions for the useLoop hook.
 * Handles CRUD and state-transition operations: update, remove, stop, discard, purge, markMerged.
 */

import { useCallback } from "react";
import {
  deleteLoopApi,
  stopLoopApi,
  discardLoopApi,
  purgeLoopApi,
  markMergedApi,
} from "../loopActions";
import { createLogger } from "../../lib/logger";
import { appFetch } from "../../lib/public-path";
import type { Loop, UpdateLoopRequest } from "../../types";
import type { UseLoopActionsParams } from "./useLoopActions";

const log = createLogger("useLoop");

export interface UseLoopLifecycleActionsResult {
  update: (request: UpdateLoopRequest) => Promise<boolean>;
  remove: () => Promise<boolean>;
  stopLoop: () => Promise<boolean>;
  discard: () => Promise<boolean>;
  purge: () => Promise<boolean>;
  markMerged: () => Promise<boolean>;
}

export function useLoopLifecycleActions(
  params: UseLoopActionsParams,
): UseLoopLifecycleActionsResult {
  const {
    loopId,
    isActiveLoop,
    ignoreStaleLoopAction,
    ignoreStaleLoopError,
    setLoop,
    setError,
    refresh,
  } = params;

  const update = useCallback(
    async (request: UpdateLoopRequest): Promise<boolean> => {
      const actionLoopId = loopId;
      const staleAction = ignoreStaleLoopAction("update", actionLoopId, false);
      if (staleAction !== null) {
        return staleAction;
      }
      log.info("Updating loop", {
        loopId: actionLoopId,
        hasNameUpdate: request.name !== undefined,
      });
      try {
        const response = await appFetch(`/api/loops/${actionLoopId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.message || "Failed to update loop");
        }
        const data = (await response.json()) as Loop;
        if (!isActiveLoop(actionLoopId)) {
          return false;
        }
        setLoop(data);
        log.info("Loop updated successfully", { loopId: actionLoopId });
        return true;
      } catch (err) {
        const staleError = ignoreStaleLoopError("update", actionLoopId, false, err);
        if (staleError !== null) {
          return staleError;
        }
        log.error("Failed to update loop", { loopId: actionLoopId, error: String(err) });
        setError(String(err));
        return false;
      }
    },
    [ignoreStaleLoopAction, ignoreStaleLoopError, isActiveLoop, loopId, setError, setLoop],
  );

  const remove = useCallback(async (): Promise<boolean> => {
    const actionLoopId = loopId;
    const staleAction = ignoreStaleLoopAction("remove", actionLoopId, false);
    if (staleAction !== null) {
      return staleAction;
    }
    log.info("Deleting loop", { loopId: actionLoopId });
    try {
      await deleteLoopApi(actionLoopId);
      if (!isActiveLoop(actionLoopId)) {
        return false;
      }
      setLoop(null);
      log.info("Loop deleted", { loopId: actionLoopId });
      return true;
    } catch (err) {
      const staleError = ignoreStaleLoopError("remove", actionLoopId, false, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to delete loop", { loopId: actionLoopId, error: String(err) });
      setError(String(err));
      return false;
    }
  }, [ignoreStaleLoopAction, ignoreStaleLoopError, isActiveLoop, loopId, refresh, setError, setLoop]);

  const stopLoop = useCallback(async (): Promise<boolean> => {
    const actionLoopId = loopId;
    const staleAction = ignoreStaleLoopAction("stopLoop", actionLoopId, false);
    if (staleAction !== null) {
      return staleAction;
    }
    log.info("Stopping loop", { loopId: actionLoopId });
    try {
      await stopLoopApi(actionLoopId);
      await refresh();
      if (!isActiveLoop(actionLoopId)) {
        return false;
      }
      log.info("Loop stopped", { loopId: actionLoopId });
      return true;
    } catch (err) {
      const staleError = ignoreStaleLoopError("stopLoop", actionLoopId, false, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to stop loop", { loopId: actionLoopId, error: String(err) });
      setError(String(err));
      return false;
    }
  }, [ignoreStaleLoopAction, ignoreStaleLoopError, isActiveLoop, loopId, refresh, setError]);

  const discard = useCallback(async (): Promise<boolean> => {
    const actionLoopId = loopId;
    const staleAction = ignoreStaleLoopAction("discard", actionLoopId, false);
    if (staleAction !== null) {
      return staleAction;
    }
    log.info("Discarding loop", { loopId: actionLoopId });
    try {
      await discardLoopApi(actionLoopId);
      await refresh();
      if (!isActiveLoop(actionLoopId)) {
        return false;
      }
      log.info("Loop discarded", { loopId: actionLoopId });
      return true;
    } catch (err) {
      const staleError = ignoreStaleLoopError("discard", actionLoopId, false, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to discard loop", { loopId: actionLoopId, error: String(err) });
      setError(String(err));
      return false;
    }
  }, [ignoreStaleLoopAction, ignoreStaleLoopError, isActiveLoop, loopId, refresh, setError]);

  const purge = useCallback(async (): Promise<boolean> => {
    const actionLoopId = loopId;
    const staleAction = ignoreStaleLoopAction("purge", actionLoopId, false);
    if (staleAction !== null) {
      return staleAction;
    }
    log.info("Purging loop", { loopId: actionLoopId });
    try {
      await purgeLoopApi(actionLoopId);
      if (!isActiveLoop(actionLoopId)) {
        return false;
      }
      setLoop(null);
      log.info("Loop purged", { loopId: actionLoopId });
      return true;
    } catch (err) {
      const staleError = ignoreStaleLoopError("purge", actionLoopId, false, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to purge loop", { loopId: actionLoopId, error: String(err) });
      setError(String(err));
      return false;
    }
  }, [ignoreStaleLoopAction, ignoreStaleLoopError, isActiveLoop, loopId, refresh, setError, setLoop]);

  const markMerged = useCallback(async (): Promise<boolean> => {
    const actionLoopId = loopId;
    const staleAction = ignoreStaleLoopAction("markMerged", actionLoopId, false);
    if (staleAction !== null) {
      return staleAction;
    }
    log.info("Marking loop as merged", { loopId: actionLoopId });
    try {
      await markMergedApi(actionLoopId);
      await refresh();
      if (!isActiveLoop(actionLoopId)) {
        return false;
      }
      log.info("Loop marked as merged", { loopId: actionLoopId });
      return true;
    } catch (err) {
      const staleError = ignoreStaleLoopError("markMerged", actionLoopId, false, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to mark loop as merged", { loopId: actionLoopId, error: String(err) });
      setError(String(err));
      return false;
    }
  }, [ignoreStaleLoopAction, ignoreStaleLoopError, isActiveLoop, loopId, refresh, setError]);

  return { update, remove, stopLoop, discard, purge, markMerged };
}
