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
  saveStoredLoopCheapModelPreference,
  saveStoredLoopModelPreference,
} from "../../lib/model-selection-preferences";
import { appFetch } from "../../lib/public-path";
import { toDraftLoopUpdateRequest } from "../../lib/loop-request";

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

async function persistLoopPreferences(
  workspaces: Workspace[],
  request: CreateLoopRequest,
): Promise<void> {
  const operations: Promise<Response>[] = [];

  operations.push(
    appFetch("/api/preferences/last-model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.model),
    }),
  );

  if (request.cheapModel) {
    operations.push(
      appFetch("/api/preferences/last-cheap-model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.cheapModel),
      }),
    );
  }

  if (request.workspaceId) {
    const workspace = workspaces.find((item) => item.id === request.workspaceId);
    if (workspace) {
      operations.push(
        appFetch("/api/preferences/last-directory", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ directory: workspace.directory }),
        }),
      );
    }
  }

  await Promise.all(operations);
}

function persistLocalLoopPreferences(request: CreateLoopRequest): void {
  saveStoredLoopModelPreference(request.model);
  saveStoredLoopCheapModelPreference(request.cheapModel);
}

export async function handleCreateLoopSubmit(
  props: SubmitHandlerProps,
  editLoop: Loop | null | undefined,
  request: CreateLoopRequest,
  toast: { error: (msg: string) => void },
): Promise<boolean> {
  const isEditing = !!editLoop;

  if (isEditing && editLoop) {
    const persistDraftChanges = async (): Promise<boolean> => {
      try {
        const response = await appFetch(`/api/loops/${editLoop.config.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(toDraftLoopUpdateRequest(request)),
        });

        if (!response.ok) {
          const error = await response.json();
          log.error("Failed to update draft:", error);
          toast.error("Failed to update draft");
          return false;
        }

        props.setLastModel(request.model);
        props.setLastCheapModel(request.cheapModel ?? null);
        persistLocalLoopPreferences(request);
        try {
          await persistLoopPreferences(props.workspaces, request);
        } catch (error) {
          log.error("Failed to persist loop preferences after draft update:", error);
        }
        await props.onRefresh();
        return true;
      } catch (error) {
        log.error("Failed to update draft:", error);
        toast.error("Failed to update draft");
        return false;
      }
    };

    if (request.draft) {
      return await persistDraftChanges();
    }

    const persisted = await persistDraftChanges();
    if (!persisted) {
      return false;
    }

    try {
      const startResponse = await appFetch(`/api/loops/${editLoop.config.id}/draft/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planMode: request.planMode ?? false,
          attachments: request.attachments,
        }),
      });

      if (!startResponse.ok) {
        const error = await startResponse.json();

        if (error.error === "uncommitted_changes") {
          props.setUncommittedModal({
            open: true,
            loopId: editLoop.config.id,
            error: error.message,
          });
          return true;
        }

        log.error("Failed to start draft:", error);
        toast.error("Failed to start loop");
        return false;
      }

      await props.onRefresh();
      return true;
    } catch (error) {
      log.error("Failed to start draft:", error);
      toast.error("Failed to start loop");
      return false;
    }
  }

  const result = await props.onCreateLoop(request);

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
      await persistLoopPreferences(props.workspaces, request);
    } catch {
      // Ignore errors saving preferences
    }
    return true;
  }

  return false;
}
