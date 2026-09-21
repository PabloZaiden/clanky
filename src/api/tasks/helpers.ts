/**
 * Shared helper functions used across multiple tasks API route modules.
 */

import { taskManager } from "../../core/task-manager";
import { createLogger } from "@pablozaiden/webapp/server";
import { isModelEnabled } from "../../core/model-discovery";
import { isTaskOperationError, type TaskOperationError } from "../../core/task/task-errors";
import { domainErrorResponse, errorResponse } from "../helpers";
import { isDomainError } from "../../domain/domain-error";

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
      return domainErrorResponse(error, {
        policy: "tasks",
        fallback: {
          error: "uncommitted_changes",
          message: "Cannot start because the repository has uncommitted changes",
          status: 409,
        },
      });
    }

    if (error.code === "directory_in_use") {
      log.warn("Task start blocked because the directory is already in use", {
        ...context,
        error: error.message,
      });
      return domainErrorResponse(error, {
        policy: "tasks",
        fallback: {
          error: "directory_in_use",
          message: "The directory is already in use.",
          status: 409,
        },
      });
    }

    if (error.code === "operation_in_progress") {
      log.warn("Task start blocked because another start is already in progress", {
        ...context,
        error: error.message,
      });
      return domainErrorResponse(error, {
        policy: "tasks",
        fallback: {
          error: "operation_in_progress",
          message: "Another task operation is already in progress.",
          status: 409,
        },
      });
    }
  }

  if (isDomainError(error) && error.code === "workspace_worktrees_disabled") {
    log.warn("Task start blocked because worktrees are disabled", {
      ...context,
      error: error.message,
    });
    return domainErrorResponse(error, {
      policy: "tasks",
      fallback: {
        error: "workspace_worktrees_disabled",
        message: "Worktrees are disabled for this workspace.",
        status: 409,
      },
    });
  }

  log.error("Task start failed", {
    ...context,
    error: String(error),
    fallbackCode,
  });
  return errorResponse(fallbackCode, fallbackMessage, 500);
}

export function taskErrorResponse(
  error: TaskOperationError,
  fallback: { error: string; message: string; status?: number },
): Response {
  return domainErrorResponse(error, {
    policy: "tasks",
    fallback,
  });
}
