import { useCallback, useEffect, useRef, useState } from "react";
import { createLogger, useRealtimeRefresh } from "@pablozaiden/webapp/web";
import {
  PROMPT_TEMPLATES_REALTIME_RESOURCE,
  type PromptTemplate,
  type PromptTemplatePreferences,
} from "@/shared/prompt-templates";
import { apiRequest } from "../lib/api-client";
import { browserPreferences } from "../client-sdk/browser-preferences";
import { isBrowserCollaborationClient } from "../client-sdk/browser-runtime";
import {
  usePreferenceLifecycle,
  type PreferenceErrorContext,
} from "./usePreferenceLifecycle";

const log = createLogger("usePromptTemplates");
const INITIAL_PREFERENCES: PromptTemplatePreferences = { templates: [], planningTemplateEnabled: true, planningTemplateIndex: 0 };

export interface UsePromptTemplatesResult {
  templates: PromptTemplate[];
  planningTemplateEnabled: boolean;
  planningTemplateIndex: number;
  loading: boolean;
  loaded: boolean;
  saving: boolean;
  error: string | null;
  loadError: string | null;
  saveError: string | null;
  clearSaveError: () => void;
  refresh: () => Promise<void>;
  updateTemplates: (templates: PromptTemplate[], planningTemplateIndex?: number) => Promise<PromptTemplate[] | null>;
  updatePlanningTemplateEnabled: (enabled: boolean) => Promise<boolean>;
}

export function usePromptTemplates(): UsePromptTemplatesResult {
  const [saveError, setSaveError] = useState<string | null>(null);
  const savePendingRef = useRef(false);
  const refreshPendingRef = useRef(false);
  const activeRefreshesRef = useRef(0);

  const loadPreference = useCallback(async (signal: AbortSignal): Promise<PromptTemplatePreferences> => {
    if (isBrowserCollaborationClient()) {
      const templates = browserPreferences.promptTemplates.read(signal);
      return {
        templates,
        planningTemplateEnabled: browserPreferences.planningTemplateEnabled.read(signal),
        planningTemplateIndex: Math.min(browserPreferences.planningTemplateIndex.read(signal), templates.length),
      };
    }
    return await apiRequest<PromptTemplatePreferences>(
      "/api/preferences/prompt-templates",
      {
        signal,
        action: "Load message templates",
        fallbackMessage: "Failed to load message templates",
      },
    );
  }, []);

  const savePreference = useCallback(async (
    value: PromptTemplatePreferences,
    signal: AbortSignal,
  ): Promise<PromptTemplatePreferences> => {
    if (isBrowserCollaborationClient()) return {
      templates: browserPreferences.promptTemplates.write(value.templates, signal),
      planningTemplateEnabled: browserPreferences.planningTemplateEnabled.write(value.planningTemplateEnabled, signal),
      planningTemplateIndex: browserPreferences.planningTemplateIndex.write(Math.min(value.planningTemplateIndex, value.templates.length), signal),
    };
    return await apiRequest<PromptTemplatePreferences>(
      "/api/preferences/prompt-templates",
      {
        signal,
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
        action: "Save message templates",
        fallbackMessage: "Failed to save message templates",
      },
    );
  }, []);

  const handlePreferenceError = useCallback((context: PreferenceErrorContext<PromptTemplatePreferences>) => {
    const action = context.operation === "load" ? "load" : "save";
    log.error(`Failed to ${action} message templates`, {
      error: String(context.error),
    });
    if (context.operation === "save") {
      setSaveError(String(context.error));
    }
  }, []);

  const preference = usePreferenceLifecycle({
    initialValue: INITIAL_PREFERENCES,
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
    enabled: !isBrowserCollaborationClient(),
    resources: [PROMPT_TEMPLATES_REALTIME_RESOURCE],
    refresh,
  });

  useEffect(() => {
    if (!isBrowserCollaborationClient()) return;
    const subscriptions = [
      browserPreferences.promptTemplates.subscribe(() => { void refresh(); }),
      browserPreferences.planningTemplateEnabled.subscribe(() => { void refresh(); }),
      browserPreferences.planningTemplateIndex.subscribe(() => { void refresh(); }),
    ];
    return () => subscriptions.forEach((unsubscribe) => unsubscribe());
  }, [refresh]);

  const clearSaveError = useCallback(() => {
    setSaveError(null);
  }, []);

  const updatePreference = useCallback(async (
    value: PromptTemplatePreferences,
  ): Promise<PromptTemplatePreferences | null> => {
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
      await preference.saveValue(value, { throwOnError: true });
      return value;
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

  const updateTemplates = useCallback(async (
    templates: PromptTemplate[],
    planningTemplateIndex = preference.value.planningTemplateIndex,
  ) => {
    const saved = await updatePreference({ ...preference.value, templates, planningTemplateIndex });
    return saved?.templates ?? null;
  }, [preference.value, updatePreference]);

  const updatePlanningTemplateEnabled = useCallback(async (enabled: boolean) => {
    return await updatePreference({ ...preference.value, planningTemplateEnabled: enabled }) !== null;
  }, [preference.value, updatePreference]);

  const loadError = preference.errorOperation === "load" ? preference.error : null;

  return {
    templates: preference.value.templates,
    planningTemplateEnabled: preference.value.planningTemplateEnabled,
    planningTemplateIndex: preference.value.planningTemplateIndex,
    loading: preference.loading,
    loaded: preference.loaded,
    saving: preference.saving,
    error: loadError ?? saveError,
    loadError,
    saveError,
    clearSaveError,
    refresh,
    updateTemplates,
    updatePlanningTemplateEnabled,
  };
}
