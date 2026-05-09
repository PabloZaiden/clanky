import type {
  CheapModelSelection,
  ModelConfig,
  UncommittedChangesError,
  Workspace,
} from "../types";
import type { CreateLoopFormSubmitRequest } from "../types/loop-request";
import { createLogger } from "./logger";
import {
  saveStoredLoopCheapModelPreference,
  saveStoredLoopModelPreference,
} from "./model-selection-preferences";
import { toDraftLoopUpdateRequest } from "./loop-request";
import { appFetch } from "./public-path";

const log = createLogger("DraftLoopStart");

interface PersistLoopPreferencesOptions {
  workspaces: Workspace[];
  request: CreateLoopFormSubmitRequest;
}

interface PersistDraftChangesOptions extends PersistLoopPreferencesOptions {
  loopId: string;
  setLastModel: (model: ModelConfig | null) => void;
  setLastCheapModel: (selection: CheapModelSelection | null) => void;
  onRefresh: () => Promise<void>;
  onUpdateError: (message: string) => void;
}

interface StartDraftLoopOptions {
  loopId: string;
  request: CreateLoopFormSubmitRequest;
  onRefresh: () => Promise<void>;
}

export type DraftStartResult =
  | { status: "started" }
  | { status: "uncommitted_changes"; error: UncommittedChangesError }
  | { status: "failed"; message: string };

export async function persistLoopPreferences({
  workspaces,
  request,
}: PersistLoopPreferencesOptions): Promise<void> {
  const operations: Promise<Response>[] = [];

  if (request.model) {
    operations.push(appFetch("/api/preferences/last-model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.model),
    }));
  }

  if (request.cheapModel) {
    operations.push(
      appFetch("/api/preferences/last-cheap-model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.cheapModel),
      }),
    );
  }

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

  await Promise.all(operations);
}

export function persistLocalLoopPreferences(request: CreateLoopFormSubmitRequest): void {
  if (request.model) {
    saveStoredLoopModelPreference(request.model);
  }
  saveStoredLoopCheapModelPreference(request.cheapModel);
}

export async function persistDraftChanges({
  loopId,
  request,
  workspaces,
  setLastModel,
  setLastCheapModel,
  onRefresh,
  onUpdateError,
}: PersistDraftChangesOptions): Promise<boolean> {
  try {
    const response = await appFetch(`/api/loops/${loopId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toDraftLoopUpdateRequest(request)),
    });

    if (!response.ok) {
      const error = await response.json() as { message?: string };
      onUpdateError(error.message || "Failed to update draft");
      return false;
    }

    if (request.model) {
      setLastModel(request.model);
    }
    setLastCheapModel(request.cheapModel ?? null);
    persistLocalLoopPreferences(request);

    try {
      await persistLoopPreferences({ workspaces, request });
    } catch (error) {
      log.error("Failed to persist loop preferences after draft update:", error);
    }

    await onRefresh();
    return true;
  } catch (error) {
    onUpdateError(String(error));
    return false;
  }
}

export async function startDraftLoop({
  loopId,
  request,
  onRefresh,
}: StartDraftLoopOptions): Promise<DraftStartResult> {
  try {
    const response = await appFetch(`/api/loops/${loopId}/draft/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        planMode: request.planMode ?? false,
        attachments: request.attachments,
      }),
    });

    if (!response.ok) {
      const error = await response.json() as Partial<UncommittedChangesError> & { message?: string };

      if (response.status === 409 && error.error === "uncommitted_changes") {
        return {
          status: "uncommitted_changes",
          error: {
            error: "uncommitted_changes",
            message: error.message || "Directory has uncommitted changes.",
            changedFiles: error.changedFiles ?? [],
          },
        };
      }
      return {
        status: "failed",
        message: error.message || "Failed to start loop",
      };
    }

    await onRefresh();
    return { status: "started" };
  } catch (error) {
    return {
      status: "failed",
      message: String(error),
    };
  }
}
