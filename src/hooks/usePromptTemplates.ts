import { useCallback, useRef, useState } from "react";
import { createLogger, useRealtimeRefresh } from "@pablozaiden/webapp/web";
import {
  PROMPT_TEMPLATES_REALTIME_RESOURCE,
  type PromptTemplate,
} from "@/shared/prompt-templates";
import { apiRequest } from "../lib/api-client";
import {
  usePreferenceLifecycle,
  type PreferenceErrorContext,
} from "./usePreferenceLifecycle";

const log = createLogger("usePromptTemplates");
const EMPTY_TEMPLATES: PromptTemplate[] = [];

export interface UsePromptTemplatesResult {
  templates: PromptTemplate[];
  loading: boolean;
  loaded: boolean;
  saving: boolean;
  error: string | null;
  loadError: string | null;
  saveError: string | null;
  clearSaveError: () => void;
  refresh: () => Promise<void>;
  updateTemplates: (templates: PromptTemplate[]) => Promise<PromptTemplate[] | null>;
}

export function usePromptTemplates(): UsePromptTemplatesResult {
  const [saveError, setSaveError] = useState<string | null>(null);
  const savePendingRef = useRef(false);
  const refreshPendingRef = useRef(false);
  const activeRefreshesRef = useRef(0);

  const loadPreference = useCallback(async (signal: AbortSignal): Promise<PromptTemplate[]> => {
    const data = await apiRequest<{ templates: PromptTemplate[] }>(
      "/api/preferences/prompt-templates",
      {
        signal,
        action: "Load message templates",
        fallbackMessage: "Failed to load message templates",
      },
    );
    return data.templates;
  }, []);

  const savePreference = useCallback(async (
    templates: PromptTemplate[],
    signal: AbortSignal,
  ): Promise<PromptTemplate[]> => {
    const data = await apiRequest<{ templates: PromptTemplate[] }>(
      "/api/preferences/prompt-templates",
      {
        signal,
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templates }),
        action: "Save message templates",
        fallbackMessage: "Failed to save message templates",
      },
    );
    return data.templates;
  }, []);

  const handlePreferenceError = useCallback((context: PreferenceErrorContext<PromptTemplate[]>) => {
    const action = context.operation === "load" ? "load" : "save";
    log.error(`Failed to ${action} message templates`, {
      error: String(context.error),
    });
    if (context.operation === "save") {
      setSaveError(String(context.error));
    }
  }, []);

  const preference = usePreferenceLifecycle({
    initialValue: EMPTY_TEMPLATES,
    load: loadPreference,
    save: savePreference,
    onError: handlePreferenceError,
  });

  const refresh = useCallback(async () => {
    if (savePendingRef.current) {
      // Re-read after the mutation settles so its delayed response cannot replace newer data.
      refreshPendingRef.current = true;
      return;
    }

    activeRefreshesRef.current += 1;
    try {
      await preference.refresh();
    } finally {
      activeRefreshesRef.current -= 1;
    }
  }, [preference.refresh]);

  useRealtimeRefresh({
    resources: [PROMPT_TEMPLATES_REALTIME_RESOURCE],
    refresh,
  });

  const clearSaveError = useCallback(() => {
    setSaveError(null);
  }, []);

  const updateTemplates = useCallback(async (
    templates: PromptTemplate[],
  ): Promise<PromptTemplate[] | null> => {
    if (
      !preference.loaded
      || preference.loading
      || preference.errorOperation === "load"
      || preference.saving
      || savePendingRef.current
      || activeRefreshesRef.current > 0
    ) {
      log.warn("Refusing to save message templates while a load or save is pending");
      return null;
    }

    savePendingRef.current = true;
    setSaveError(null);
    try {
      await preference.saveValue(templates, { throwOnError: true });
      return templates;
    } catch {
      return null;
    } finally {
      savePendingRef.current = false;
      if (refreshPendingRef.current) {
        refreshPendingRef.current = false;
        await refresh();
      }
    }
  }, [
    preference.errorOperation,
    preference.loaded,
    preference.loading,
    preference.saveValue,
    preference.saving,
    refresh,
  ]);

  const loadError = preference.errorOperation === "load" ? preference.error : null;

  return {
    templates: preference.value,
    loading: preference.loading,
    loaded: preference.loaded,
    saving: preference.saving,
    error: loadError ?? saveError,
    loadError,
    saveError,
    clearSaveError,
    refresh,
    updateTemplates,
  };
}
