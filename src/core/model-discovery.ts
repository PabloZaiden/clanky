/**
 * Provider-aware model discovery and validation.
 *
 * Backend connections, workspace resolution, normalization, caching, and
 * model availability rules belong to Core rather than API route modules.
 */

import { backendManager } from "./backend-manager";
import { DomainError } from "../domain/domain-error";
import { workspaceManager } from "./workspace-manager";
import type { ModelInfo } from "@/contracts";
import { createAgentSettings, type ServerSettings } from "@/shared/settings";
import type { Workspace } from "@/shared/workspace";
import { getAgentExecutionHostCapability, type ExecutionHostBinding } from "@/shared/execution-host";
import { requireCurrentUserId } from "../context/user-context";
import { executionHostService } from "./execution-host-service";

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

function createCacheKey(parts: unknown[]): string {
  return JSON.stringify([requireCurrentUserId(), ...parts]);
}

function getWorkspaceCatalogCacheKey(
  workspace: Workspace,
  directory: string,
  modelID?: string,
): string {
  executionHostService.requireBindingCapability(
    workspace.executionHostBinding,
    getAgentExecutionHostCapability(workspace.serverSettings.agent.adapter),
    undefined,
    1,
  );
  return createCacheKey([
    modelID === undefined ? "models" : "variants",
    "workspace",
    workspace.id,
    workspace.executionHostBinding,
    workspace.serverSettings.agent,
    directory,
    modelID ?? null,
  ]);
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

function normalizeDiscoveredModels(settings: ServerSettings, models: ModelInfo[]): ModelInfo[] {
  return settings.agent.adapter === "acp" && settings.agent.provider === "copilot"
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

  return await getModelsForDirectory(workspace, workspace.directory);
}

export async function getModelsForExecutionHost(
  binding: ExecutionHostBinding,
  directory: string,
  provider: ServerSettings["agent"]["provider"],
  sshPassword?: string,
): Promise<ModelInfo[]> {
  executionHostService.requireBindingCapability(binding, getAgentExecutionHostCapability("acp"), undefined, 1);
  const cacheKey = createCacheKey(["models", "execution-host", binding, createAgentSettings("acp", provider), directory]);
  const cached = getCacheValue(modelListCache, cacheKey);
  if (cached) {
    return cached;
  }
  const models = await backendManager.withExecutionHostBackend(
    { binding, provider, directory, sshPassword },
    async (backend, settings) => normalizeDiscoveredModels(settings, await backend.getModels(directory)),
  );
  if (models.length > 0) {
    setCacheValue(modelListCache, cacheKey, models);
  }
  return models;
}

export async function getModelsForDirectory(
  workspace: Workspace,
  directory: string,
): Promise<ModelInfo[]> {
  const cacheKey = getWorkspaceCatalogCacheKey(workspace, directory);
  const cached = getCacheValue(modelListCache, cacheKey);
  if (cached) {
    return cached;
  }

  const models = await backendManager.withWorkspaceBackend(
    {
      workspaceId: workspace.id,
      directory,
      settings: workspace.serverSettings,
      expectedBinding: workspace.executionHostBinding,
    },
    async (backend) => await backend.getModels(directory),
  );
  const normalizedModels = normalizeDiscoveredModels(workspace.serverSettings, models);
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
  const cacheKey = getWorkspaceCatalogCacheKey(workspace, directory, modelID);
  const cached = getCacheValue(modelVariantCache, cacheKey);
  if (cached) {
    return cached;
  }

  const variants = await backendManager.withWorkspaceBackend(
    {
      workspaceId,
      directory,
      settings: workspace.serverSettings,
      expectedBinding: workspace.executionHostBinding,
    },
    async (backend) => {
      if (backend.getModelVariants) {
        return await backend.getModelVariants(directory, modelID);
      }
      const model = (await backend.getModels(directory)).find((entry) => entry.modelID === modelID);
      return model?.variants && model.variants.length > 0 ? model.variants : [""];
    },
  );
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
