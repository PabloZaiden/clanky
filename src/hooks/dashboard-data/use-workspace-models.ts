/**
 * Sub-hook for workspace model fetching and last-model preference.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { createLogger } from "@pablozaiden/webapp/web";
import type { CheapModelSelection, ModelConfig } from "@/shared";
import type { ModelInfo } from "@/contracts";
import { apiRequest } from "../../lib/api-client";
import { ModelConfigSchema } from "@/contracts/schemas/model";

export interface UseWorkspaceModelsResult {
  models: ModelInfo[];
  modelsLoading: boolean;
  lastModel: ModelConfig | null;
  setLastModel: (model: ModelConfig | null) => void;
  lastCheapModel: CheapModelSelection | null;
  setLastCheapModel: (selection: CheapModelSelection | null) => void;
  modelsWorkspaceId: string | null;
  fetchModels: (workspaceId: string | null) => Promise<void>;
  resetModels: () => void;
}

function normalizeLastModelPreference(value: unknown): ModelConfig | null {
  if (value === null || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const validation = ModelConfigSchema.safeParse({
    providerID: candidate["providerID"],
    modelID: candidate["modelID"],
    variant: typeof candidate["variant"] === "string" ? candidate["variant"] : "",
  });

  if (!validation.success) {
    return null;
  }

  return validation.data;
}

export function useWorkspaceModels(): UseWorkspaceModelsResult {
  const log = createLogger("useWorkspaceModels");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [lastModel, setLastModel] = useState<ModelConfig | null>(null);
  const [lastCheapModel, setLastCheapModel] = useState<CheapModelSelection | null>(null);
  const [modelsWorkspaceId, setModelsWorkspaceId] = useState<string | null>(null);

  const modelsRequestIdRef = useRef(0);
  const modelsAbortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      modelsAbortControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    async function fetchLastModel() {
      try {
        const raw = await apiRequest<unknown>("/api/preferences/last-model", {
          action: "Load last model preference",
          fallbackMessage: "Failed to load last model preference",
        });
        const data = normalizeLastModelPreference(raw);
        if (raw !== null && data === null) {
          log.warn("Failed to normalize last model preference response");
        }
        setLastModel(data);
      } catch (error) {
        log.warn("Failed to fetch last model preference", { error: String(error) });
      }
    }
    async function fetchLastCheapModel() {
      try {
        const data = await apiRequest<CheapModelSelection | null>("/api/preferences/last-cheap-model", {
          action: "Load last cheap model preference",
          fallbackMessage: "Failed to load last cheap model preference",
        });
        setLastCheapModel(data);
      } catch (error) {
        log.warn("Failed to fetch last cheap model preference", { error: String(error) });
      }
    }
    void fetchLastModel();
    void fetchLastCheapModel();
  }, []);

  const fetchModels = useCallback(async (workspaceId: string | null) => {
    const requestId = ++modelsRequestIdRef.current;
    modelsAbortControllerRef.current?.abort();
    setModelsWorkspaceId(workspaceId);
    setModels([]);

    if (!workspaceId) {
      setModelsLoading(false);
      return;
    }

    const controller = new AbortController();
    modelsAbortControllerRef.current = controller;

    setModelsLoading(true);
    try {
      const data = await apiRequest<ModelInfo[]>(
        `/api/models?workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          signal: controller.signal,
          action: "Load workspace models",
          fallbackMessage: "Failed to fetch workspace models",
        },
      );
      if (controller.signal.aborted || requestId !== modelsRequestIdRef.current) {
        return;
      }
      setModels(data);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      log.error("Failed to fetch workspace models", {
        workspaceId,
        error: String(error),
      });
      if (requestId === modelsRequestIdRef.current) {
        setModels([]);
      }
    } finally {
      if (!controller.signal.aborted && requestId === modelsRequestIdRef.current) {
        setModelsLoading(false);
      }
    }
  }, []);

  const resetModels = useCallback(() => {
    modelsRequestIdRef.current += 1;
    modelsAbortControllerRef.current?.abort();
    modelsAbortControllerRef.current = null;
    setModels([]);
    setModelsWorkspaceId(null);
    setModelsLoading(false);
  }, []);

  return {
    models,
    modelsLoading,
    lastModel,
    setLastModel,
    lastCheapModel,
    setLastCheapModel,
    modelsWorkspaceId,
    fetchModels,
    resetModels,
  };
}
