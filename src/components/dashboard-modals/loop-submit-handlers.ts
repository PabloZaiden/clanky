/**
 * Submit handler helpers for the Create/Edit Loop modal — pure business logic
 * that delegates to the appropriate API calls and updates state accordingly.
 */

import type {
  CheapModelSelection,
  CreateLoopRequest,
  Loop,
  ModelConfig,
  UncommittedChangesError,
  Workspace,
} from "../../types";
import type { CreateLoopFormSubmitRequest } from "../CreateLoopForm";
import type { CreateLoopResult } from "../../hooks/useLoops";
import { createLogger } from "../../lib/logger";
import {
  persistDraftChanges,
  persistLocalLoopPreferences,
  persistLoopPreferences,
  startDraftLoop,
} from "../../lib/draft-loop-start";

const log = createLogger("DashboardModals");

export function isCreateLoopRequest(request: CreateLoopFormSubmitRequest): request is CreateLoopRequest {
  return "name" in request;
}

interface SubmitHandlerProps {
  workspaces: Workspace[];
  setLastModel: (model: ModelConfig | null) => void;
  setLastCheapModel: (selection: CheapModelSelection | null) => void;
  setUncommittedModal: (state: { open: boolean; loopId: string | null; error: UncommittedChangesError | null }) => void;
  onRefresh: () => Promise<void>;
  onCreateLoop: (request: CreateLoopRequest) => Promise<CreateLoopResult>;
}

export async function handleCreateLoopSubmit(
  props: SubmitHandlerProps,
  editLoop: Loop | null | undefined,
  request: CreateLoopFormSubmitRequest,
  toast: { error: (msg: string) => void },
): Promise<boolean> {
  const isEditing = !!editLoop;

  if (isEditing && editLoop) {
    if (request.draft) {
      return await persistDraftChanges({
        loopId: editLoop.config.id,
        request,
        workspaces: props.workspaces,
        setLastModel: props.setLastModel,
        setLastCheapModel: props.setLastCheapModel,
        onRefresh: props.onRefresh,
        onUpdateError: (message) => {
          log.error("Failed to update draft:", { loopId: editLoop.config.id, message });
          toast.error(message);
        },
      });
    }

    if (!request.model) {
      toast.error("Please select a model before starting a loop.");
      return false;
    }

    void (async () => {
      const persisted = await persistDraftChanges({
        loopId: editLoop.config.id,
        request,
        workspaces: props.workspaces,
        setLastModel: props.setLastModel,
        setLastCheapModel: props.setLastCheapModel,
        onRefresh: props.onRefresh,
        onUpdateError: (message) => {
          log.error("Failed to update draft:", { loopId: editLoop.config.id, message });
          toast.error(message);
        },
      });
      if (!persisted) {
        return;
      }

      const result = await startDraftLoop({
        loopId: editLoop.config.id,
        request,
        onRefresh: props.onRefresh,
      });

      if (result.status === "uncommitted_changes") {
        props.setUncommittedModal({
          open: true,
          loopId: editLoop.config.id,
          error: result.error,
        });
        return;
      }

      if (result.status === "failed") {
        log.error("Failed to start draft:", {
          loopId: editLoop.config.id,
          message: result.message,
        });
        toast.error(result.message);
      }
    })();

    return true;
  }

  if (!request.model) {
    toast.error("Please select a model before creating a loop.");
    return false;
  }

  const createRequest: CreateLoopRequest = {
    ...request,
    model: request.model,
  };
  const result = await props.onCreateLoop(createRequest);

  if (result.startError) {
    props.setUncommittedModal({
      open: true,
      loopId: result.loop?.config.id ?? null,
      error: result.startError,
    });
    return true;
  }

  if (result.loop) {
    await props.onRefresh();

    if (request.model) {
      props.setLastModel(request.model);
    }
    props.setLastCheapModel(request.cheapModel ?? null);
    persistLocalLoopPreferences(request);

    try {
      await persistLoopPreferences({
        workspaces: props.workspaces,
        request,
      });
    } catch (error) {
      log.error("Failed to persist loop preferences after create:", error);
    }
    return true;
  }

  return false;
}
