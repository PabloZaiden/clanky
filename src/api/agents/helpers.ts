/**
 * Narrow helpers shared by scheduled-agent API route modules.
 */

import type { ModelConfig } from "@/shared/model";
import { isModelEnabled } from "../../core/model-discovery";
import { errorResponse, requireWorkspace } from "../helpers";

/**
 * Validate that a workspace exists and exposes the requested model.
 *
 * The route modules own request parsing and response decisions; this helper
 * only centralizes the repeated workspace/model boundary check.
 */
export async function validateAgentModel(
  workspaceId: string,
  model: ModelConfig,
): Promise<Response | null> {
  const workspace = await requireWorkspace(workspaceId);
  if (workspace instanceof Response) {
    return workspace;
  }

  const modelValidation = await isModelEnabled(
    workspace.id,
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
