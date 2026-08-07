/**
 * Hook for managing the markdown rendering preference.
 * Provides access to the global markdown rendering setting.
 */

import { useCallback, useEffect, useRef } from "react";
import { createLogger } from "@pablozaiden/webapp/web";
import { apiRequest } from "../lib/api-client";
import {
  usePreferenceLifecycle,
  type PreferenceErrorContext,
} from "./usePreferenceLifecycle";

export interface UseMarkdownPreferenceResult {
  /** Whether markdown rendering is enabled */
  enabled: boolean;
  /** Whether the preference is being loaded */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /** Whether a save operation is in progress */
  saving: boolean;
  /** Toggle the markdown rendering preference */
  toggle: () => Promise<void>;
  /** Set the markdown rendering preference to a specific value */
  setEnabled: (enabled: boolean) => Promise<void>;
}

/**
 * Hook for managing the global markdown rendering preference.
 * The setting persists across browser sessions.
 */
export function useMarkdownPreference(): UseMarkdownPreferenceResult {
  const log = createLogger("useMarkdownPreference");
  const loadPreference = useCallback(async (signal: AbortSignal): Promise<boolean> => {
    const data = await apiRequest<{ enabled: boolean }>("/api/preferences/markdown-rendering", {
      signal,
      action: "Load markdown preference",
      fallbackMessage: "Failed to fetch preference",
    });
    return data.enabled;
  }, []);

  const savePreference = useCallback(async (
    nextEnabled: boolean,
    signal: AbortSignal,
  ): Promise<void> => {
    await apiRequest("/api/preferences/markdown-rendering", {
      signal,
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: nextEnabled }),
      action: "Save markdown preference",
      fallbackMessage: "Failed to save preference",
    });
  }, []);

  const handlePreferenceError = useCallback((context: PreferenceErrorContext<boolean>) => {
    if (context.operation === "load") {
      log.error("Failed to fetch markdown preference", { error: String(context.error) });
      return;
    }
    log.error("Failed to save markdown preference", {
      enabled: context.value,
      error: String(context.error),
    });
  }, []);

  const preference = usePreferenceLifecycle({
    initialValue: true,
    load: loadPreference,
    save: savePreference,
    onError: handlePreferenceError,
  });

  const enabledRef = useRef(preference.value);
  useEffect(() => {
    enabledRef.current = preference.value;
  }, [preference.value]);

  const setEnabled = useCallback(async (nextEnabled: boolean) => {
    await preference.saveValue(nextEnabled);
  }, [preference.saveValue]);

  const toggle = useCallback(async () => {
    await setEnabled(!enabledRef.current);
  }, [setEnabled]);

  return {
    enabled: preference.value,
    loading: preference.loading,
    error: preference.error,
    saving: preference.saving,
    toggle,
    setEnabled,
  };
}
