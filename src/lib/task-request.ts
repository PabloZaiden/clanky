import type { UpdateTaskRequest } from "../types";
import type { CreateTaskFormSubmitRequest } from "../types/task-request";

/**
 * Draft editors start from the create-task form shape, but draft PUT requests
 * must use the narrower update contract.
 */
export function toDraftTaskUpdateRequest(request: CreateTaskFormSubmitRequest): UpdateTaskRequest {
  return {
    name: request.name,
    prompt: request.prompt,
    cheapModel: request.cheapModel,
    maxIterations: request.maxIterations,
    maxConsecutiveErrors: request.maxConsecutiveErrors,
    activityTimeoutSeconds: request.activityTimeoutSeconds,
    stopPattern: request.stopPattern,
    git: request.git,
    baseBranch: request.baseBranch,
    useWorktree: request.useWorktree,
    clearPlanningFolder: request.clearPlanningFolder,
    planMode: request.planMode,
    autoAcceptPlan: request.autoAcceptPlan,
    fullyAutonomous: request.fullyAutonomous,
    ...(request.model ? { model: request.model } : {}),
  };
}
