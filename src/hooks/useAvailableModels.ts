/**
 * Shared hook for fetching available models for a workspace.
 */

import { useEffect, useState } from "react";
import type { ModelInfo } from "../types";
import { log } from "../lib/logger";
import { appFetch } from "../lib/public-path";

export interface UseAvailableModelsOptions {
  workspaceId: string | undefined;
}

export interface UseAvailableModelsResult {
  models: ModelInfo[];
  modelsLoading: boolean;
}

export function useAvailableModels({
  workspaceId,
}: UseAvailableModelsOptions): UseAvailableModelsResult {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  useEffect(() => {
    if (!workspaceId) {
      setModels([]);
      setModelsLoading(false);
      return;
    }

    const controller = new AbortController();
    const resolvedWorkspaceId = workspaceId;

    async function fetchModels() {
      setModelsLoading(true);
      try {
        const response = await appFetch(
          `/api/models?workspaceId=${encodeURIComponent(resolvedWorkspaceId)}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) {
          return;
        }
        if (response.ok) {
          const data = await response.json() as ModelInfo[];
          if (controller.signal.aborted) {
            return;
          }
          setModels(data);
          return;
        }
        setModels([]);
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
  }, [workspaceId]);

  return { models, modelsLoading };
}
