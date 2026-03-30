/**
 * Loops state management hook.
 * Provides CRUD operations and real-time state updates for loops.
 */

export type { CreateLoopResult } from "./use-loop-mutations";
export type { UseLoopsStateResult } from "./use-loops-state";

import { useLoopsState } from "./use-loops-state";
import { useLoopEvents } from "./use-loop-events";
import { useLoopMutations, type CreateLoopResult } from "./use-loop-mutations";
import { useLoopActions } from "./use-loop-actions";
import type { AcceptLoopResult, PushLoopResult, AddressCommentsResult, PurgeArchivedLoopsResult } from "../loopActions";
import type { Loop, CreateLoopRequest, UpdateLoopRequest } from "../../types";
import type { MessageImageAttachment } from "../../types/message-attachments";

export interface UseLoopsResult {
  /** Array of all loops */
  loops: Loop[];
  /** Whether loops are currently loading */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /** Refresh loops from the server */
  refresh: () => Promise<void>;
  /** Create a new loop (loops are always started immediately) */
  createLoop: (request: CreateLoopRequest) => Promise<CreateLoopResult>;
  /** Update an existing loop */
  updateLoop: (id: string, request: UpdateLoopRequest) => Promise<Loop | null>;
  /** Delete a loop */
  deleteLoop: (id: string) => Promise<boolean>;
  /** Accept (merge) a loop's changes */
  acceptLoop: (id: string) => Promise<AcceptLoopResult>;
  /** Push a loop's branch to remote */
  pushLoop: (id: string) => Promise<PushLoopResult>;
  /** Update a pushed loop's branch by syncing with the base branch and re-pushing */
  updateBranch: (id: string) => Promise<PushLoopResult>;
  /** Discard a loop's changes */
  discardLoop: (id: string) => Promise<boolean>;
  /** Purge a loop (permanently delete - only for merged/pushed/deleted loops) */
  purgeLoop: (id: string) => Promise<boolean>;
  /** Purge all archived loops for a workspace */
  purgeArchivedWorkspaceLoops: (workspaceId: string) => Promise<PurgeArchivedLoopsResult>;
  /** Address reviewer comments (only for pushed/merged loops with reviewMode.addressable = true) */
  addressReviewComments: (id: string, comments: string, attachments?: MessageImageAttachment[]) => Promise<AddressCommentsResult>;
  /** Get a loop by ID */
  getLoop: (id: string) => Loop | undefined;
}

/**
 * Hook for managing loops state with real-time updates via WebSocket.
 */
export function useLoops(): UseLoopsResult {
  const { loops, loading, error, setLoops, setError, refresh, refreshLoop, getLoop } = useLoopsState();

  useLoopEvents({ refresh, refreshLoop, setLoops });

  const { createLoop, updateLoop, deleteLoop } = useLoopMutations({ setError, setLoops });

  const { acceptLoop, pushLoop, updateBranch, discardLoop, purgeLoop, purgeArchivedWorkspaceLoops, addressReviewComments } =
    useLoopActions({ setError, setLoops, refreshLoop });

  return {
    loops,
    loading,
    error,
    refresh,
    createLoop,
    updateLoop,
    deleteLoop,
    acceptLoop,
    pushLoop,
    updateBranch,
    discardLoop,
    purgeLoop,
    purgeArchivedWorkspaceLoops,
    addressReviewComments,
    getLoop,
  };
}
