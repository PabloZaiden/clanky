import { createLogger } from "./logger";
import { getModelsForSettings } from "./model-discovery";
import { workspaceManager } from "./workspace-manager";
import type { CheapModelSelection, ModelConfig } from "@/shared";
import type { ModelInfo } from "@/contracts";

const log = createLogger("core:cheap-model");

function modelVariantExists(model: ModelInfo, variant: string): boolean {
  if (!model.variants || model.variants.length === 0) {
    return variant === "";
  }
  return model.variants.includes(variant);
}

async function getWorkspaceModels(
  workspaceId: string,
  directory: string,
): Promise<ModelInfo[]> {
  const workspace = await workspaceManager.requireWorkspace(workspaceId);
  return await getModelsForSettings(workspaceId, directory, workspace.serverSettings);
}

function hasEnabledModel(models: ModelInfo[], model: ModelConfig): boolean {
  const match = models.find(
    (candidate) =>
      candidate.providerID === model.providerID
      && candidate.modelID === model.modelID,
  );
  if (!match?.connected) {
    return false;
  }
  return modelVariantExists(match, model.variant ?? "");
}

export async function resolveEffectiveCheapModel(options: {
  workspaceId: string;
  directory: string;
  model: ModelConfig;
  cheapModel?: CheapModelSelection;
  operation: string;
}): Promise<ModelConfig> {
  if (!options.cheapModel || options.cheapModel.mode === "same-as-task") {
    return options.model;
  }

  try {
    const models = await getWorkspaceModels(options.workspaceId, options.directory);
    if (hasEnabledModel(models, options.cheapModel.model)) {
      return options.cheapModel.model;
    }

    log.info("Falling back to task model because cheap model is unavailable", {
      workspaceId: options.workspaceId,
      operation: options.operation,
      cheapModelProvider: options.cheapModel.model.providerID,
      cheapModelId: options.cheapModel.model.modelID,
    });
  } catch (error) {
    log.warn("Failed to validate cheap model, falling back to task model", {
      workspaceId: options.workspaceId,
      operation: options.operation,
      error: String(error),
    });
  }

  return options.model;
}
