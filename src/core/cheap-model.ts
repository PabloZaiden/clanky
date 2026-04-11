import { backendManager, buildConnectionConfig } from "./backend-manager";
import { createLogger } from "./logger";
import { getWorkspace } from "../persistence/workspaces";
import type { CheapModelSelection, ModelConfig, ModelInfo } from "../types";

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
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  const settings = workspace.serverSettings;
  const testBackend = backendManager.getTestBackend();
  if (testBackend) {
    if (!testBackend.isConnected()) {
      await testBackend.connect(buildConnectionConfig(settings, directory));
    }
    return await testBackend.getModels(directory);
  }

  const existingBackend = backendManager.getInitializedBackend(workspaceId);
  if (existingBackend?.isConnected() && existingBackend.getDirectory() === directory) {
    return await existingBackend.getModels(directory);
  }

  const tempBackend = backendManager.createBackend(settings);
  try {
    await tempBackend.connect(buildConnectionConfig(settings, directory));
    return await tempBackend.getModels(directory);
  } finally {
    try {
      await tempBackend.disconnect();
    } catch (disconnectError) {
      log.trace("Failed to disconnect temporary backend while resolving cheap model", {
        error: String(disconnectError),
      });
    }
  }
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
  if (!options.cheapModel || options.cheapModel.mode === "same-as-loop") {
    return options.model;
  }

  try {
    const models = await getWorkspaceModels(options.workspaceId, options.directory);
    if (hasEnabledModel(models, options.cheapModel.model)) {
      return options.cheapModel.model;
    }

    log.info("Falling back to loop model because cheap model is unavailable", {
      workspaceId: options.workspaceId,
      operation: options.operation,
      cheapModelProvider: options.cheapModel.model.providerID,
      cheapModelId: options.cheapModel.model.modelID,
    });
  } catch (error) {
    log.warn("Failed to validate cheap model, falling back to loop model", {
      workspaceId: options.workspaceId,
      operation: options.operation,
      error: String(error),
    });
  }

  return options.model;
}
