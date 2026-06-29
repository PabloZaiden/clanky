/**
 * Model discovery helpers: backend querying, Copilot normalization,
 * and model-enabled validation.
 *
 * @module api/models/model-discovery
 */

import { backendManager, buildConnectionConfig } from "../../core/backend-manager";
import { getWorkspace } from "../../persistence/workspaces";
import type { ServerSettings } from "../../types/settings";
import type { ModelInfo } from "../../types/api";
import { createLogger } from "../../core/logger";

const log = createLogger("api:models");
const MODEL_DISCOVERY_CACHE_TTL_MS = 12 * 60 * 60 * 1_000;

interface TimedCacheEntry<T> {
  value: T;
  expiresAt: number;
}

const modelListCache = new Map<string, TimedCacheEntry<ModelInfo[]>>();
const modelVariantCache = new Map<string, TimedCacheEntry<string[]>>();

function getCacheValue<T>(cache: Map<string, TimedCacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCacheValue<T>(cache: Map<string, TimedCacheEntry<T>>, key: string, value: T): void {
  cache.set(key, {
    value,
    expiresAt: Date.now() + MODEL_DISCOVERY_CACHE_TTL_MS,
  });
}

function getModelListCacheKey(workspaceId: string, provider: string): string {
  return `${workspaceId}:${provider}`;
}

function getModelVariantCacheKey(workspaceId: string, provider: string, modelID: string): string {
  return `${workspaceId}:${provider}:${modelID}`;
}

/**
 * Result of checking if a model is enabled/connected.
 */
export interface ModelValidationResult {
  /** Whether the model is enabled and can be used */
  enabled: boolean;
  /** Error message if the model is not enabled */
  error?: string;
  /** Error code for programmatic handling */
  errorCode?: "model_not_enabled" | "model_not_found" | "provider_not_found" | "validation_failed";
}

/**
 * Normalize ACP-discovered Copilot models to the API contract used by the UI.
 */
function normalizeCopilotModelInfo(models: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  return models
    .map((model) => ({
      ...model,
      providerID: "copilot",
      providerName: "Copilot",
    }))
    .filter((model) => {
      if (seen.has(model.modelID)) {
        return false;
      }
      seen.add(model.modelID);
      return true;
    });
}

/**
 * Discover models via the configured agent backend (ACP path).
 */
async function getAgentBackendModels(
  connectionId: string,
  directory: string,
  settings: ServerSettings,
): Promise<ModelInfo[]> {
  const testBackend = backendManager.getTestBackend();
  if (testBackend) {
    if (testBackend.isConnected()) {
      await testBackend.disconnect();
    }
    await testBackend.connect(buildConnectionConfig(settings, directory));
    return await testBackend.getModels(directory);
  }

  const existingBackend = backendManager.getInitializedBackend(connectionId);
  if (existingBackend?.isConnected()) {
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
      log.trace("Failed to disconnect temporary backend", { error: String(disconnectError) });
    }
  }
}

async function getAgentBackendModelVariants(
  connectionId: string,
  directory: string,
  settings: ServerSettings,
  modelID: string,
): Promise<string[]> {
  const testBackend = backendManager.getTestBackend();
  if (testBackend) {
    if (testBackend.isConnected()) {
      await testBackend.disconnect();
    }
    await testBackend.connect(buildConnectionConfig(settings, directory));
    if (testBackend.getModelVariants) {
      return await testBackend.getModelVariants(directory, modelID);
    }
    const model = (await testBackend.getModels(directory)).find((entry) => entry.modelID === modelID);
    return model?.variants && model.variants.length > 0 ? model.variants : [""];
  }

  const existingBackend = backendManager.getInitializedBackend(connectionId);
  if (existingBackend?.isConnected()) {
    if (existingBackend.getModelVariants) {
      return await existingBackend.getModelVariants(directory, modelID);
    }
    const model = (await existingBackend.getModels(directory)).find((entry) => entry.modelID === modelID);
    return model?.variants && model.variants.length > 0 ? model.variants : [""];
  }

  const tempBackend = backendManager.createBackend(settings);
  try {
    await tempBackend.connect(buildConnectionConfig(settings, directory));
    if (tempBackend.getModelVariants) {
      return await tempBackend.getModelVariants(directory, modelID);
    }
    const model = (await tempBackend.getModels(directory)).find((entry) => entry.modelID === modelID);
    return model?.variants && model.variants.length > 0 ? model.variants : [""];
  } finally {
    try {
      await tempBackend.disconnect();
    } catch (disconnectError) {
      log.trace("Failed to disconnect temporary backend", { error: String(disconnectError) });
    }
  }
}

/**
 * Discover models for a workspace using provider-aware routing.
 */
export async function getModelsForWorkspace(
  workspaceId: string,
  directory: string,
  workspaceOverride?: Awaited<ReturnType<typeof getWorkspace>>,
): Promise<ModelInfo[]> {
  const workspace = workspaceOverride ?? await getWorkspace(workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  const settings = workspace.serverSettings;
  const cacheKey = getModelListCacheKey(workspaceId, settings.agent.provider);
  const cached = getCacheValue(modelListCache, cacheKey);
  if (cached) {
    return cached;
  }

  const models = await getAgentBackendModels(workspaceId, directory, settings);
  const normalizedModels = settings.agent.provider === "copilot"
    ? normalizeCopilotModelInfo(models)
    : models;
  if (normalizedModels.length > 0) {
    setCacheValue(modelListCache, cacheKey, normalizedModels);
  }
  return normalizedModels;
}

export async function getModelsForSettings(
  connectionId: string,
  directory: string,
  settings: ServerSettings,
): Promise<ModelInfo[]> {
  const cacheKey = getModelListCacheKey(connectionId, settings.agent.provider);
  const cached = getCacheValue(modelListCache, cacheKey);
  if (cached) {
    return cached;
  }

  const models = await getAgentBackendModels(connectionId, directory, settings);
  const normalizedModels = settings.agent.provider === "copilot"
    ? normalizeCopilotModelInfo(models)
    : models;
  if (normalizedModels.length > 0) {
    setCacheValue(modelListCache, cacheKey, normalizedModels);
  }
  return normalizedModels;
}

export async function getModelVariantsForWorkspace(
  workspaceId: string,
  directory: string,
  providerID: string,
  modelID: string,
  workspaceOverride?: Awaited<ReturnType<typeof getWorkspace>>,
): Promise<string[]> {
  const workspace = workspaceOverride ?? await getWorkspace(workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  const settings = workspace.serverSettings;
  const cacheKey = getModelVariantCacheKey(workspaceId, providerID, modelID);
  const cached = getCacheValue(modelVariantCache, cacheKey);
  if (cached) {
    return cached;
  }

  const variants = await getAgentBackendModelVariants(workspaceId, directory, settings, modelID);
  const normalizedVariants = variants.length > 0 ? variants : [""];
  setCacheValue(modelVariantCache, cacheKey, normalizedVariants);
  return normalizedVariants;
}

/**
 * Check if a model is enabled (its provider is connected).
 *
 * This function fetches the available models for a workspace and checks
 * if the specified model exists and its provider is connected.
 *
 * Discovery is provider-aware through the configured ACP backend.
 *
 * @param workspaceId - The workspace ID to check models for
 * @param directory - The working directory path
 * @param providerID - The provider ID (e.g., "anthropic")
 * @param modelID - The model ID (e.g., "claude-sonnet-4-20250514")
 * @returns Promise with validation result
 */
export async function isModelEnabled(
  workspaceId: string,
  directory: string,
  providerID: string,
  modelID: string,
): Promise<ModelValidationResult> {
  try {
    const models = await getModelsForWorkspace(workspaceId, directory);

    // Check if the provider exists
    const providerModels = models.filter((m) => m.providerID === providerID);
    if (providerModels.length === 0) {
      return {
        enabled: false,
        error: `Provider not found: ${providerID}`,
        errorCode: "provider_not_found",
      };
    }

    // Check if the specific model exists
    const model = providerModels.find((m) => m.modelID === modelID);
    if (!model) {
      return {
        enabled: false,
        error: `Model not found: ${modelID}`,
        errorCode: "model_not_found",
      };
    }

    // Check if the model's provider is connected
    if (!model.connected) {
      return {
        enabled: false,
        error: "The selected model's provider is not connected. Please check your API credentials.",
        errorCode: "model_not_enabled",
      };
    }

    return { enabled: true };
  } catch (error) {
    return {
      enabled: false,
      error: `Failed to validate model: ${String(error)}`,
      errorCode: "validation_failed",
    };
  }
}
