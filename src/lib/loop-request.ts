import type { UpdateLoopRequest } from "../types";
import type { CreateLoopFormSubmitRequest } from "../types/loop-request";

/**
 * Draft editors start from the create-loop form shape, but draft PUT requests
 * must use the narrower update contract.
 */
export function toDraftLoopUpdateRequest(request: CreateLoopFormSubmitRequest): UpdateLoopRequest {
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
