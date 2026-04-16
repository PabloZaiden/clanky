import type { CreateLoopRequest, UpdateLoopRequest } from "../types";

/**
 * Draft editors start from the create-loop form shape, but draft PUT requests
 * must use the narrower update contract.
 */
export function toDraftLoopUpdateRequest(request: CreateLoopRequest): UpdateLoopRequest {
  return {
    name: request.name,
    prompt: request.prompt,
    model: request.model,
    cheapModel: request.cheapModel,
    maxIterations: request.maxIterations ?? undefined,
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
  };
}
