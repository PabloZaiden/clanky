/**
 * Shared hook for fetching available models for a workspace directory.
 */

import { useEffect, useState } from "react";
import type { ModelInfo } from "../types";
import { log } from "../lib/logger";
import { appFetch } from "../lib/public-path";

const availableModelsCache = new Map<string, ModelInfo[]>();
const availableModelsRequests = new Map<string, Promise<ModelInfo[]>>();

function getModelsCacheKey(workspaceId: string, directory: string): string {
  return JSON.stringify([workspaceId, directory]);
}

async function fetchModelsForCache(workspaceId: string, directory: string): Promise<ModelInfo[]> {
  const cacheKey = getModelsCacheKey(workspaceId, directory);
  const cached = availableModelsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const existingRequest = availableModelsRequests.get(cacheKey);
  if (existingRequest) {
    return await existingRequest;
  }

  const request = (async () => {
    const response = await appFetch(
      `/api/models?directory=${encodeURIComponent(directory)}&workspaceId=${encodeURIComponent(workspaceId)}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`);
    }
    const data = await response.json() as ModelInfo[];
    availableModelsCache.set(cacheKey, data);
    return data;
  })();

  availableModelsRequests.set(cacheKey, request);
  try {
    return await request;
  } finally {
    availableModelsRequests.delete(cacheKey);
  }
}

export interface UseAvailableModelsOptions {
  directory: string | undefined;
  workspaceId: string | undefined;
}

export interface UseAvailableModelsResult {
  models: ModelInfo[];
  modelsLoading: boolean;
}

export function useAvailableModels({
  directory,
  workspaceId,
}: UseAvailableModelsOptions): UseAvailableModelsResult {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  useEffect(() => {
    if (!directory || !workspaceId) {
      setModels([]);
      setModelsLoading(false);
      return;
    }

    const controller = new AbortController();
    const resolvedDirectory = directory;
    const resolvedWorkspaceId = workspaceId;
    const cached = availableModelsCache.get(getModelsCacheKey(resolvedWorkspaceId, resolvedDirectory));
    if (cached) {
      setModels(cached);
      setModelsLoading(false);
      return () => {
        controller.abort();
      };
    }

    async function fetchModels() {
      setModelsLoading(true);
      try {
        const data = await fetchModelsForCache(resolvedWorkspaceId, resolvedDirectory);
        if (controller.signal.aborted) {
          return;
        }
        setModels(data);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        log.error("Failed to fetch models:", String(error));
        setModels([]);
      } finally {
        if (!controller.signal.aborted) {
          setModelsLoading(false);
        }
      }
    }

    void fetchModels();

    return () => {
      controller.abort();
    };
  }, [directory, workspaceId]);

  return { models, modelsLoading };
}
