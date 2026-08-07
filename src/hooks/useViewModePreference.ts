/**
 * Hook for managing the dashboard view mode preference.
 * Provides access to the view mode setting (rows or cards).
 */

import { useCallback, useEffect, useRef } from "react";
import { createLogger } from "@pablozaiden/webapp/web";
import type { DashboardViewMode } from "@/shared/preferences";
import { apiRequest } from "../lib/api-client";
import {
  usePreferenceLifecycle,
  type PreferenceErrorContext,
} from "./usePreferenceLifecycle";

/**
 * Re-export DashboardViewMode so existing consumers of this module don't break.
 */
export type { DashboardViewMode } from "@/shared/preferences";

export interface UseViewModePreferenceResult {
  /** Current view mode */
  viewMode: DashboardViewMode;
  /** Whether the preference is being loaded */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /** Whether a save operation is in progress */
  saving: boolean;
  /** Toggle between rows and cards */
  toggle: () => Promise<void>;
  /** Set the view mode to a specific value */
  setViewMode: (mode: DashboardViewMode) => Promise<void>;
}

/**
 * Hook for managing the dashboard view mode preference.
 * The setting persists across browser sessions via server-side storage.
 */
export function useViewModePreference(): UseViewModePreferenceResult {
  const log = createLogger("useViewModePreference");
  const loadPreference = useCallback(async (signal: AbortSignal): Promise<DashboardViewMode> => {
    const data = await apiRequest<{ mode: DashboardViewMode }>("/api/preferences/dashboard-view-mode", {
      signal,
      action: "Load dashboard view mode preference",
      fallbackMessage: "Failed to fetch preference",
    });
    return data.mode;
  }, []);

  const savePreference = useCallback(async (
    newMode: DashboardViewMode,
    signal: AbortSignal,
  ): Promise<void> => {
    await apiRequest("/api/preferences/dashboard-view-mode", {
      signal,
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: newMode }),
      action: "Save dashboard view mode preference",
      fallbackMessage: "Failed to save preference",
    });
  }, []);

  const handlePreferenceError = useCallback((context: PreferenceErrorContext<DashboardViewMode>) => {
    if (context.operation === "load") {
      log.error("Failed to fetch dashboard view mode preference", { error: String(context.error) });
      return;
    }
    log.error("Failed to save dashboard view mode preference", {
      viewMode: context.value,
      error: String(context.error),
    });
  }, []);

  const preference = usePreferenceLifecycle({
    initialValue: "rows" as DashboardViewMode,
    load: loadPreference,
    save: savePreference,
    onError: handlePreferenceError,
  });

  const viewModeRef = useRef(preference.value);
  useEffect(() => {
    viewModeRef.current = preference.value;
  }, [preference.value]);

  const setViewMode = useCallback(async (newMode: DashboardViewMode) => {
    await preference.saveValue(newMode);
  }, [preference.saveValue]);

  const toggle = useCallback(async () => {
    const newMode = viewModeRef.current === "rows" ? "cards" : "rows";
    await setViewMode(newMode);
  }, [setViewMode]);

  return {
    viewMode: preference.value,
    loading: preference.loading,
    error: preference.error,
    saving: preference.saving,
    toggle,
    setViewMode,
  };
}
