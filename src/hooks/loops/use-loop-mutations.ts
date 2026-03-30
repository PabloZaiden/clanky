/**
 * Loop CRUD mutations: create, update, delete.
 */

import { useCallback } from "react";
import type { Loop, CreateLoopRequest, UpdateLoopRequest, UncommittedChangesError } from "../../types";
import { createLogger } from "../../lib/logger";
import { appFetch } from "../../lib/public-path";
import { deleteLoopApi } from "../loopActions";

export interface CreateLoopResult {
  /** The created loop, or null if creation failed */
  loop: Loop | null;
  /** Error if the loop was created but failed to start (e.g., uncommitted changes) */
  startError?: UncommittedChangesError;
}

interface UseLoopMutationsOptions {
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setLoops: React.Dispatch<React.SetStateAction<Loop[]>>;
}

export interface UseLoopMutationsResult {
  createLoop: (request: CreateLoopRequest) => Promise<CreateLoopResult>;
  updateLoop: (id: string, request: UpdateLoopRequest) => Promise<Loop | null>;
  deleteLoop: (id: string) => Promise<boolean>;
}

export function useLoopMutations({ setError, setLoops }: UseLoopMutationsOptions): UseLoopMutationsResult {
  const log = createLogger("useLoopMutations");
  const createLoop = useCallback(async (request: CreateLoopRequest): Promise<CreateLoopResult> => {
    try {
      const response = await appFetch("/api/loops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });

      // Handle uncommitted changes error (409)
      if (response.status === 409) {
        const errorData = (await response.json()) as { error?: string };
        if (errorData.error === "uncommitted_changes") {
          return {
            loop: null,
            startError: errorData as UncommittedChangesError,
          };
        }
      }

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to create loop");
      }

      const loop = (await response.json()) as Loop;
      // Don't add to state here - let the WebSocket event handle it
      // to avoid duplicate entries during the brief moment before refresh completes
      return { loop };
    } catch (err) {
      log.error("Failed to create loop", {
        workspaceId: request.workspaceId,
        useWorktree: request.useWorktree,
        error: String(err),
      });
      setError(String(err));
      return { loop: null };
    }
  }, [setError]);

  const updateLoop = useCallback(async (id: string, request: UpdateLoopRequest): Promise<Loop | null> => {
    try {
      const response = await appFetch(`/api/loops/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to update loop");
      }
      const loop = (await response.json()) as Loop;
      // Update state immediately for config changes (no WebSocket event for PATCH)
      setLoops((prev) => prev.map((l) => (l.config.id === id ? loop : l)));
      return loop;
    } catch (err) {
      log.error("Failed to update loop", { loopId: id, error: String(err) });
      setError(String(err));
      return null;
    }
  }, [setError, setLoops]);

  const deleteLoop = useCallback(async (id: string): Promise<boolean> => {
    try {
      await deleteLoopApi(id);
      // Don't remove from state here - let the WebSocket event handle it
      // to avoid race conditions with state updates
      return true;
    } catch (err) {
      log.error("Failed to delete loop", { loopId: id, error: String(err) });
      setError(String(err));
      return false;
    }
  }, [setError]);

  return { createLoop, updateLoop, deleteLoop };
}
