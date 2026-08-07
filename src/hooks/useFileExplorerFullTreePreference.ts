/**
 * Hook for managing the file explorer full-tree loading preference.
 */

import { useCallback, useEffect, useRef } from "react";
import { createLogger } from "@pablozaiden/webapp/web";
import { apiRequest } from "../lib/api-client";
import {
  usePreferenceLifecycle,
  type PreferenceErrorContext,
} from "./usePreferenceLifecycle";

export interface UseFileExplorerFullTreePreferenceResult {
  enabled: boolean;
  loading: boolean;
  error: string | null;
  saving: boolean;
  toggle: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
}

export function useFileExplorerFullTreePreference(): UseFileExplorerFullTreePreferenceResult {
  const log = createLogger("useFileExplorerFullTreePreference");
  const loadPreference = useCallback(async (signal: AbortSignal): Promise<boolean> => {
    const data = await apiRequest<{ enabled: boolean }>("/api/preferences/file-explorer-full-tree", {
      signal,
      action: "Load file explorer full-tree preference",
      fallbackMessage: "Failed to fetch preference",
    });
    return data.enabled;
  }, []);

  const savePreference = useCallback(async (
    nextEnabled: boolean,
    signal: AbortSignal,
  ): Promise<void> => {
    await apiRequest("/api/preferences/file-explorer-full-tree", {
      signal,
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: nextEnabled }),
      action: "Save file explorer full-tree preference",
      fallbackMessage: "Failed to save preference",
    });
  }, []);

  const handlePreferenceError = useCallback((context: PreferenceErrorContext<boolean>) => {
    if (context.operation === "load") {
      log.error("Failed to fetch file explorer full-tree preference", { error: String(context.error) });
      return;
    }
    log.error("Failed to save file explorer full-tree preference", {
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
    await preference.saveValue(nextEnabled, { throwOnError: true });
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
