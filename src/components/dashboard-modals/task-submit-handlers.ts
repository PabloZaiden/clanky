/**
 * Submit handler helpers for the Create/Edit Task modal — pure business logic
 * that delegates to the appropriate API calls and updates state accordingly.
 */

import type {
  CheapModelSelection,
  CreateTaskRequest,
  Task,
  ModelConfig,
  UncommittedChangesError,
  Workspace,
} from "../../types";
import type { CreateTaskFormSubmitRequest } from "../../types/task-request";
import type { CreateTaskResult } from "../../hooks/useTasks";
import { createLogger } from "../../lib/logger";
import {
  persistDraftChanges,
  persistLocalTaskPreferences,
  persistTaskPreferences,
  startDraftTask,
} from "../../lib/draft-task-start";

const log = createLogger("DashboardModals");

export function isCreateTaskRequest(request: CreateTaskFormSubmitRequest): request is CreateTaskRequest {
  return "name" in request;
}

interface SubmitHandlerProps {
  workspaces: Workspace[];
  setLastModel: (model: ModelConfig | null) => void;
  setLastCheapModel: (selection: CheapModelSelection | null) => void;
  setUncommittedModal: (state: { open: boolean; taskId: string | null; error: UncommittedChangesError | null }) => void;
  onRefresh: () => Promise<void>;
  onCreateTask: (request: CreateTaskRequest) => Promise<CreateTaskResult>;
}

export async function handleCreateTaskSubmit(
  props: SubmitHandlerProps,
  editTask: Task | null | undefined,
  request: CreateTaskFormSubmitRequest,
  toast: { error: (msg: string) => void },
): Promise<boolean> {
  const isEditing = !!editTask;

  if (isEditing && editTask) {
    if (request.draft) {
      return await persistDraftChanges({
        taskId: editTask.config.id,
        request,
        workspaces: props.workspaces,
        setLastModel: props.setLastModel,
        setLastCheapModel: props.setLastCheapModel,
        onRefresh: props.onRefresh,
        onUpdateError: (message) => {
          log.error("Failed to update draft:", { taskId: editTask.config.id, message });
          toast.error(message);
        },
      });
    }

    if (!request.model) {
      toast.error("Please select a model before starting a task.");
      return false;
    }

    void (async () => {
      const persisted = await persistDraftChanges({
        taskId: editTask.config.id,
        request,
        workspaces: props.workspaces,
        setLastModel: props.setLastModel,
        setLastCheapModel: props.setLastCheapModel,
        onRefresh: props.onRefresh,
        onUpdateError: (message) => {
          log.error("Failed to update draft:", { taskId: editTask.config.id, message });
          toast.error(message);
        },
      });
      if (!persisted) {
        return;
      }

      const result = await startDraftTask({
        taskId: editTask.config.id,
        request,
        onRefresh: props.onRefresh,
      });

      if (result.status === "uncommitted_changes") {
        props.setUncommittedModal({
          open: true,
          taskId: editTask.config.id,
          error: result.error,
        });
        return;
      }

      if (result.status === "failed") {
        log.error("Failed to start draft:", {
          taskId: editTask.config.id,
          message: result.message,
        });
        toast.error(result.message);
      }
    })();

    return true;
  }

  if (!request.model) {
    toast.error("Please select a model before creating a task.");
    return false;
  }

  const createRequest: CreateTaskRequest = {
    ...request,
    model: request.model,
  };
  const result = await props.onCreateTask(createRequest);

  if (result.startError) {
    props.setUncommittedModal({
      open: true,
      taskId: result.task?.config.id ?? null,
      error: result.startError,
    });
    return true;
  }

  if (result.task) {
    await props.onRefresh();

    if (request.model) {
      props.setLastModel(request.model);
    }
    props.setLastCheapModel(request.cheapModel ?? null);
    persistLocalTaskPreferences(request);

    try {
      await persistTaskPreferences({
        workspaces: props.workspaces,
        request,
      });
    } catch (error) {
      log.error("Failed to persist task preferences after create:", error);
    }
    return true;
  }

  return false;
}
