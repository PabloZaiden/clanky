/**
 * Sub-hook for workspace model fetching and last-model preference.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { createLogger } from "../../lib/logger";
import type { CheapModelSelection, ModelConfig, ModelInfo } from "../../types";
import { appFetch } from "../../lib/public-path";
import { ModelConfigSchema } from "../../types/schemas/model";

export interface UseWorkspaceModelsResult {
  models: ModelInfo[];
  modelsLoading: boolean;
  lastModel: ModelConfig | null;
  setLastModel: (model: ModelConfig | null) => void;
  lastCheapModel: CheapModelSelection | null;
  setLastCheapModel: (selection: CheapModelSelection | null) => void;
  modelsWorkspaceId: string | null;
  setModelsWorkspaceId: (id: string | null) => void;
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
        const response = await appFetch("/api/preferences/last-model");
        if (response.ok) {
          const raw = await response.json() as unknown;
          const data = normalizeLastModelPreference(raw);
          if (raw !== null && data === null) {
            log.warn("Failed to normalize last model preference response");
          }
          setLastModel(data);
        }
      } catch (error) {
        log.warn("Failed to fetch last model preference", { error: String(error) });
      }
    }
    async function fetchLastCheapModel() {
      try {
        const response = await appFetch("/api/preferences/last-cheap-model");
        if (response.ok) {
          const data = await response.json() as CheapModelSelection | null;
          setLastCheapModel(data);
        }
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

    if (!workspaceId) {
      setModels([]);
      setModelsLoading(false);
      return;
    }

    const controller = new AbortController();
    modelsAbortControllerRef.current = controller;

    setModelsLoading(true);
    try {
      const response = await appFetch(
        `/api/models?workspaceId=${encodeURIComponent(workspaceId)}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted || requestId !== modelsRequestIdRef.current) {
        return;
      }
      if (response.ok) {
        const data = await response.json() as ModelInfo[];
        if (controller.signal.aborted || requestId !== modelsRequestIdRef.current) {
          return;
        }
        setModels(data);
      } else {
        setModels([]);
      }
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
    setModels([]);
    setModelsWorkspaceId(null);
  }, []);

  return {
    models,
    modelsLoading,
    lastModel,
    setLastModel,
    lastCheapModel,
    setLastCheapModel,
    modelsWorkspaceId,
    setModelsWorkspaceId,
    fetchModels,
    resetModels,
  };
}
