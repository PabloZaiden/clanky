/**
 * Shared hook for fetching available models for a workspace.
 */

import { useEffect, useState } from "react";
import type { ModelInfo } from "@/contracts";
import { log } from "@pablozaiden/webapp/web";
import { apiRequest } from "../lib/api-client";

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
        const data = await apiRequest<ModelInfo[]>(
          `/api/models?workspaceId=${encodeURIComponent(resolvedWorkspaceId)}`,
          {
            signal: controller.signal,
            action: "Load available models",
            fallbackMessage: "Failed to fetch models",
          },
        );
        if (controller.signal.aborted) {
          return;
        }
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
  }, [workspaceId]);

  return { models, modelsLoading };
}
