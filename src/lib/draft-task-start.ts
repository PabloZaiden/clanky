import type { CheapModelSelection, ModelConfig, Workspace } from "@/shared";
import type { UncommittedChangesError } from "@/contracts";
import type { CreateTaskFormSubmitRequest } from "@/lib/task-request";
import { createLogger } from "@pablozaiden/webapp/web";
import {
  saveStoredTaskCheapModelPreference,
  saveStoredTaskModelPreference,
} from "./model-selection-preferences";
import { toDraftTaskUpdateRequest } from "./task-request";
import { parseApiError } from "./api-error";
import { readApiResponse, requestApiResponse, apiRequest } from "./api-client";

const log = createLogger("DraftTaskStart");

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
  const operations: Promise<unknown>[] = [];

  if (request.model) {
    operations.push(apiRequest<unknown>("/api/preferences/last-model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.model),
      action: "Save last model preference",
    }));
  }

  if (request.cheapModel) {
    operations.push(
      apiRequest<unknown>("/api/preferences/last-cheap-model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.cheapModel),
        action: "Save last cheap model preference",
      }),
    );
  }

  const workspace = workspaces.find((item) => item.id === request.workspaceId);
  if (workspace) {
    operations.push(
      apiRequest<unknown>("/api/preferences/last-directory", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory: workspace.directory }),
        action: "Save last directory preference",
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
    await apiRequest<unknown>(`/api/tasks/${taskId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toDraftTaskUpdateRequest(request)),
      action: "Update draft task",
      fallbackMessage: "Failed to update draft",
    });

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
    const response = await requestApiResponse(`/api/tasks/${taskId}/draft/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        planMode: request.planMode ?? false,
        attachments: request.attachments,
      }),
      action: "Start draft task",
      fallbackMessage: "Failed to start task",
      acceptedStatuses: [409],
    });

    if (response.status === 409) {
      const error = await parseApiError(response, "Failed to start task");
      if (error.code === "uncommitted_changes") {
        const changedFiles = error.data?.["changedFiles"];
        return {
          status: "uncommitted_changes",
          error: {
            error: "uncommitted_changes",
            message: error.message,
            changedFiles: Array.isArray(changedFiles)
              ? changedFiles.filter((file): file is string => typeof file === "string")
              : [],
          },
        };
      }
      return {
        status: "failed",
        message: error.message,
      };
    }

    await readApiResponse(response);
    await onRefresh();
    return { status: "started" };
  } catch (error) {
    return {
      status: "failed",
      message: String(error),
    };
  }
}
