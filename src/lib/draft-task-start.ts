import type { CheapModelSelection, ModelConfig, Workspace } from "@/shared";
import type { UncommittedChangesError } from "@/contracts";
import type { CreateTaskFormSubmitRequest } from "@/lib/task-request";
import { createClientLogger } from "./client-logger";
import {
  saveStoredTaskCheapModelPreference,
  saveStoredTaskModelPreference,
} from "./model-selection-preferences";
import { toDraftTaskUpdateRequest } from "./task-request";
import { appFetch } from "./public-path";

const log = createClientLogger("DraftTaskStart");

interface PersistTaskPreferencesOptions {
  workspaces: Workspace[];
  request: CreateTaskFormSubmitRequest;
}

interface PersistDraftChangesOptions extends PersistTaskPreferencesOptions {
  taskId: string;
  setLastModel: (model: ModelConfig | null) => void;
  setLastCheapModel: (selection: CheapModelSelection | null) => void;
  onRefresh: () => Promise<void>;
  onUpdateError: (message: string) => void;
}

interface StartDraftTaskOptions {
  taskId: string;
  request: CreateTaskFormSubmitRequest;
  onRefresh: () => Promise<void>;
}

export type DraftStartResult =
  | { status: "started" }
  | { status: "uncommitted_changes"; error: UncommittedChangesError }
  | { status: "failed"; message: string };

export async function persistTaskPreferences({
  workspaces,
  request,
}: PersistTaskPreferencesOptions): Promise<void> {
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

export function persistLocalTaskPreferences(request: CreateTaskFormSubmitRequest): void {
  if (request.model) {
    saveStoredTaskModelPreference(request.model);
  }
  saveStoredTaskCheapModelPreference(request.cheapModel);
}

export async function persistDraftChanges({
  taskId,
  request,
  workspaces,
  setLastModel,
  setLastCheapModel,
  onRefresh,
  onUpdateError,
}: PersistDraftChangesOptions): Promise<boolean> {
  try {
    const response = await appFetch(`/api/tasks/${taskId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toDraftTaskUpdateRequest(request)),
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
    persistLocalTaskPreferences(request);

    try {
      await persistTaskPreferences({ workspaces, request });
    } catch (error) {
      log.error("Failed to persist task preferences after draft update:", error);
    }

    await onRefresh();
    return true;
  } catch (error) {
    onUpdateError(String(error));
    return false;
  }
}

export async function startDraftTask({
  taskId,
  request,
  onRefresh,
}: StartDraftTaskOptions): Promise<DraftStartResult> {
  try {
    const response = await appFetch(`/api/tasks/${taskId}/draft/start`, {
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
        message: error.message || "Failed to start task",
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
