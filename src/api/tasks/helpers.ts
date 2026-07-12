/**
 * Shared helper functions used across multiple tasks API route modules.
 */

import { taskManager } from "../../core/task-manager";
import { createLogger } from "../../core/logger";
import { isModelEnabled } from "../models";
import { errorResponse } from "../helpers";

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
  if (error instanceof Error) {
    const code = (error as Error & { code?: string }).code;
    const status = (error as Error & { status?: number }).status;
    const changedFiles = (error as Error & { changedFiles?: string[] }).changedFiles;

    if (code === "uncommitted_changes") {
      log.warn("Task start blocked by uncommitted changes", {
        ...context,
        error: error.message,
        changedFilesCount: changedFiles?.length ?? 0,
      });
      return Response.json(
        {
          error: "uncommitted_changes",
          message: error.message,
          changedFiles: changedFiles ?? [],
        },
        { status: status ?? 409 },
      );
    }

    if (code === "directory_in_use") {
      log.warn("Task start blocked because the directory is already in use", {
        ...context,
        error: error.message,
      });
      return errorResponse("directory_in_use", error.message, status ?? 409);
    }
  }

  log.error("Task start failed", {
    ...context,
    error: String(error),
    fallbackCode,
  });
  return errorResponse(fallbackCode, `${fallbackMessage}: ${String(error)}`, 500);
}
