/**
 * Provider-aware model discovery and validation.
 *
 * Backend connections, workspace resolution, normalization, caching, and
 * model availability rules belong to Core rather than API route modules.
 */

import { backendManager, buildConnectionConfig } from "./backend-manager";
import { DomainError } from "./domain-error";
import { createLogger } from "./logger";
import { workspaceManager } from "./workspace-manager";
import type { ModelInfo } from "@/contracts";
import type { ServerSettings } from "@/shared/settings";
import type { Workspace } from "@/shared/workspace";

const log = createLogger("core:model-discovery");
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
  pruneExpiredCacheEntries(cache);
  cache.set(key, {
    value,
    expiresAt: Date.now() + MODEL_DISCOVERY_CACHE_TTL_MS,
  });
}

function pruneExpiredCacheEntries<T>(cache: Map<string, TimedCacheEntry<T>>): void {
  const now = Date.now();
  for (const [entryKey, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(entryKey);
    }
  }
}

function createCacheKey(parts: string[]): string {
  return JSON.stringify(parts);
}

function getModelListCacheKey(connectionId: string, provider: string, directory: string): string {
  return createCacheKey(["models", connectionId, provider, directory]);
}

function getModelVariantCacheKey(
  workspaceId: string,
  provider: string,
  directory: string,
  modelID: string,
): string {
  return createCacheKey(["variants", workspaceId, provider, directory, modelID]);
}

export interface ModelValidationResult {
  enabled: boolean;
  error?: string;
  errorCode?: "model_not_enabled" | "model_not_found" | "provider_not_found" | "validation_failed";
}

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

function normalizeDiscoveredModels(settings: ServerSettings, models: ModelInfo[]): ModelInfo[] {
  return settings.agent.provider === "copilot"
    ? normalizeCopilotModelInfo(models)
    : models;
}

export async function getModelsForWorkspace(
  workspaceId: string,
  workspaceOverride?: Workspace,
): Promise<ModelInfo[]> {
  const workspace = workspaceOverride ?? await workspaceManager.getWorkspace(workspaceId);
  if (!workspace) {
    throw new DomainError("workspace_not_found", `Workspace not found: ${workspaceId}`, {
      details: { workspaceId },
    });
  }

  return await getModelsForSettings(workspaceId, workspace.directory, workspace.serverSettings);
}

export async function getModelsForSettings(
  connectionId: string,
  directory: string,
  settings: ServerSettings,
): Promise<ModelInfo[]> {
  const cacheKey = getModelListCacheKey(connectionId, settings.agent.provider, directory);
  const cached = getCacheValue(modelListCache, cacheKey);
  if (cached) {
    return cached;
  }

  const models = await getAgentBackendModels(connectionId, directory, settings);
  const normalizedModels = normalizeDiscoveredModels(settings, models);
  if (normalizedModels.length > 0) {
    setCacheValue(modelListCache, cacheKey, normalizedModels);
  }
  return normalizedModels;
}

export async function getModelVariantsForWorkspace(
  workspaceId: string,
  modelID: string,
  workspaceOverride?: Workspace,
): Promise<string[]> {
  const workspace = workspaceOverride ?? await workspaceManager.getWorkspace(workspaceId);
  if (!workspace) {
    throw new DomainError("workspace_not_found", `Workspace not found: ${workspaceId}`, {
      details: { workspaceId },
    });
  }

  const directory = workspace.directory;
  const settings = workspace.serverSettings;
  const cacheKey = getModelVariantCacheKey(workspaceId, settings.agent.provider, directory, modelID);
  const cached = getCacheValue(modelVariantCache, cacheKey);
  if (cached) {
    return cached;
  }

  const variants = await getAgentBackendModelVariants(workspaceId, directory, settings, modelID);
  const normalizedVariants = variants.length > 0 ? variants : [""];
  setCacheValue(modelVariantCache, cacheKey, normalizedVariants);
  return normalizedVariants;
}

export async function isModelEnabled(
  workspaceId: string,
  providerID: string,
  modelID: string,
): Promise<ModelValidationResult> {
  try {
    const models = await getModelsForWorkspace(workspaceId);
    const providerModels = models.filter((model) => model.providerID === providerID);
    if (providerModels.length === 0) {
      return {
        enabled: false,
        error: `Provider not found: ${providerID}`,
        errorCode: "provider_not_found",
      };
    }

    const model = providerModels.find((entry) => entry.modelID === modelID);
    if (!model) {
      return {
        enabled: false,
        error: `Model not found: ${modelID}`,
        errorCode: "model_not_found",
      };
    }

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
