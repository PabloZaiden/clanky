import { useCallback } from "react";
import { createLogger, useRealtimeRefresh } from "@pablozaiden/webapp/web";
import {
  PROMPT_TEMPLATES_REALTIME_RESOURCE,
  type PromptTemplate,
} from "@/shared/prompt-templates";
import { apiRequest } from "../lib/api-client";
import {
  usePreferenceLifecycle,
  type PreferenceErrorContext,
  type PreferenceOperation,
} from "./usePreferenceLifecycle";

const log = createLogger("usePromptTemplates");
const EMPTY_TEMPLATES: PromptTemplate[] = [];

export interface UsePromptTemplatesResult {
  templates: PromptTemplate[];
  loading: boolean;
  loaded: boolean;
  saving: boolean;
  error: string | null;
  errorOperation: PreferenceOperation | null;
  refresh: () => Promise<void>;
  updateTemplates: (templates: PromptTemplate[]) => Promise<PromptTemplate[] | null>;
}

export function usePromptTemplates(): UsePromptTemplatesResult {
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
  }, []);

  const preference = usePreferenceLifecycle({
    initialValue: EMPTY_TEMPLATES,
    load: loadPreference,
    save: savePreference,
    onError: handlePreferenceError,
  });

  useRealtimeRefresh({
    resources: [PROMPT_TEMPLATES_REALTIME_RESOURCE],
    refresh: () => preference.refresh(),
  });

  const updateTemplates = useCallback(async (
    templates: PromptTemplate[],
  ): Promise<PromptTemplate[] | null> => {
    if (!preference.loaded || preference.loading || preference.errorOperation === "load" || preference.saving) {
      log.warn("Refusing to save message templates before a successful load");
      return null;
    }

    try {
      await preference.saveValue(templates, { throwOnError: true });
      return templates;
    } catch {
      return null;
    }
  }, [
    preference.errorOperation,
    preference.loaded,
    preference.loading,
    preference.saveValue,
    preference.saving,
  ]);

  return {
    templates: preference.value,
    loading: preference.loading,
    loaded: preference.loaded,
    saving: preference.saving,
    error: preference.error,
    errorOperation: preference.errorOperation,
    refresh: preference.refresh,
    updateTemplates,
  };
}
