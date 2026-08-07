/**
 * Hook for managing the file explorer full-tree loading preference.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createLogger } from "@pablozaiden/webapp/web";
import { apiRequest } from "../lib/api-client";

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
  const [enabled, setEnabledState] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const enabledRef = useRef(enabled);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const fetchPreference = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await apiRequest<{ enabled: boolean }>("/api/preferences/file-explorer-full-tree", {
        action: "Load file explorer full-tree preference",
        fallbackMessage: "Failed to fetch preference",
      });
      setEnabledState(data.enabled);
    } catch (fetchError) {
      log.error("Failed to fetch file explorer full-tree preference", { error: String(fetchError) });
      setError(String(fetchError));
    } finally {
      setLoading(false);
    }
  }, []);

  const setEnabled = useCallback(async (nextEnabled: boolean) => {
    try {
      setSaving(true);
      setError(null);
      await apiRequest("/api/preferences/file-explorer-full-tree", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled }),
        action: "Save file explorer full-tree preference",
        fallbackMessage: "Failed to save preference",
      });
      setEnabledState(nextEnabled);
    } catch (saveError) {
      log.error("Failed to save file explorer full-tree preference", {
        enabled: nextEnabled,
        error: String(saveError),
      });
      setError(String(saveError));
      throw saveError;
    } finally {
      setSaving(false);
    }
  }, []);

  const toggle = useCallback(async () => {
    await setEnabled(!enabledRef.current);
  }, [setEnabled]);

  useEffect(() => {
    void fetchPreference();
  }, [fetchPreference]);

  return {
    enabled,
    loading,
    error,
    saving,
    toggle,
    setEnabled,
  };
}
