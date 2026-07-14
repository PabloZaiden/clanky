/**
 * Shared helper functions used across multiple tasks API route modules.
 */

import { taskManager } from "../../core/task-manager";
import { createLogger } from "../../core/logger";
import { isModelEnabled } from "../../core/model-discovery";
import { isTaskOperationError, type TaskOperationError, type TaskErrorCode } from "../../core/task/task-errors";
import { domainErrorResponse, errorResponse } from "../helpers";

const log = createLogger("api:tasks");

/**
 * Validate that the given model is enabled for the task's workspace.
 * Returns a Response if validation fails, or null if the model is valid.
 */
export async function validateEnabledModelForTask(
  taskId: string,
  model: { providerID: string; modelID: string } | undefined,
): Promise<Response | null> {
  if (!model?.providerID || !model?.modelID) {
    return null;
  }

  const task = await taskManager.getTask(taskId);
  if (!task) {
    return errorResponse("not_found", "Task not found", 404);
  }

  const modelValidation = await isModelEnabled(
    task.config.workspaceId,
    model.providerID,
    model.modelID,
  );
  if (!modelValidation.enabled) {
    return errorResponse(
      modelValidation.errorCode ?? "model_not_enabled",
      modelValidation.error ?? "The selected model is not available",
    );
  }

  return null;
}

/**
 * Map a task start error to an appropriate HTTP response.
 */
export function startErrorResponse(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
  context: Record<string, unknown> = {},
): Response {
  if (isTaskOperationError(error)) {
    if (error.code === "uncommitted_changes") {
      const changedFiles = error.details["changedFiles"];
      log.warn("Task start blocked by uncommitted changes", {
        ...context,
        error: error.message,
        changedFilesCount: Array.isArray(changedFiles) ? changedFiles.length : 0,
      });
      return Response.json(
        {
          error: "uncommitted_changes",
          message: error.message,
          changedFiles: Array.isArray(changedFiles) ? changedFiles : [],
        },
        { status: 409 },
      );
    }

    if (error.code === "directory_in_use") {
      log.warn("Task start blocked because the directory is already in use", {
        ...context,
        error: error.message,
      });
      return errorResponse("directory_in_use", error.message, 409);
    }
  }

  log.error("Task start failed", {
    ...context,
    error: String(error),
    fallbackCode,
  });
  return errorResponse(fallbackCode, fallbackMessage, 500);
}

const TASK_ERROR_MAPPINGS: Readonly<
  Record<TaskErrorCode, { error: string; message: string; status: number }>
> = {
  task_not_found: { error: "not_found", message: "Task not found", status: 404 },
  task_not_running: { error: "not_running", message: "Task is not running", status: 409 },
  task_not_planning: {
    error: "not_planning",
    message: "Task is not in planning status",
    status: 400,
  },
  plan_not_ready: {
    error: "plan_not_ready",
    message: "Plan is not ready yet",
    status: 400,
  },
  task_already_running: {
    error: "already_running",
    message: "Task is already running",
    status: 409,
  },
  invalid_task_state: {
    error: "invalid_state",
    message: "Task is in an invalid state for this operation",
    status: 400,
  },
  invalid_model_config: {
    error: "invalid_model_config",
    message: "Invalid model configuration",
    status: 400,
  },
  task_branch_missing: {
    error: "no_git_branch",
    message: "No git branch was created for this task",
    status: 400,
  },
  task_worktree_missing: {
    error: "no_worktree",
    message: "Task worktree is not available",
    status: 400,
  },
  operation_in_progress: {
    error: "operation_in_progress",
    message: "This task operation is already in progress",
    status: 409,
  },
  invalid_task_input: {
    error: "validation_error",
    message: "Invalid task input",
    status: 400,
  },
  task_not_addressable: {
    error: "invalid_state",
    message: "Task cannot receive follow-up feedback",
    status: 400,
  },
  automatic_pr_flow_disabled: {
    error: "automatic_pr_flow_disabled",
    message: "Automatic PR flow is not enabled for this task",
    status: 400,
  },
  automatic_pr_flow_busy: {
    error: "automatic_pr_flow_busy",
    message: "Automatic PR flow is already processing feedback",
    status: 409,
  },
  task_no_remote: {
    error: "no_remote",
    message: "Workspace has no git remote configured",
    status: 400,
  },
  task_operation_failed: {
    error: "task_operation_failed",
    message: "Task operation failed",
    status: 500,
  },
  task_git_operation_failed: {
    error: "task_git_operation_failed",
    message: "Task git operation failed",
    status: 500,
  },
  task_ssh_session_failed: {
    error: "task_ssh_session_failed",
    message: "Task SSH session operation failed",
    status: 500,
  },
  task_file_operation_failed: {
    error: "task_file_operation_failed",
    message: "Task file operation failed",
    status: 500,
  },
  task_session_reconnect_failed: {
    error: "task_session_reconnect_failed",
    message: "Task session could not be reconnected",
    status: 500,
  },
  uncommitted_changes: {
    error: "uncommitted_changes",
    message: "Cannot start because the repository has uncommitted changes",
    status: 409,
  },
  directory_in_use: {
    error: "directory_in_use",
    message: "The task directory is already in use",
    status: 409,
  },
};

export function taskErrorResponse(
  error: TaskOperationError,
  fallback: { error: string; message: string; status?: number },
): Response {
  if (error.code === "uncommitted_changes") {
    const changedFiles = error.details["changedFiles"];
    return errorResponse(
      "uncommitted_changes",
      error.message,
      409,
      { changedFiles: Array.isArray(changedFiles) ? changedFiles : [] },
    );
  }

  const mapping = TASK_ERROR_MAPPINGS[error.code];
  return domainErrorResponse(error, {
    mappings: {
      [error.code]: mapping,
    },
    fallback,
  });
}

/**
 * Preserve the legacy action-specific response contract while narrowing by
 * the typed task failure code.
 */
export function taskActionErrorResponse(
  error: TaskOperationError,
  fallback: { error: string; message: string; status?: number },
): Response {
  if (error.code === "task_not_found") {
    return errorResponse("not_found", "Task not found", 404);
  }
  return errorResponse(fallback.error, error.message, fallback.status ?? 500);
}
