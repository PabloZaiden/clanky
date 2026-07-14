import { useCallback, useEffect, useRef, useState } from "react";
import { createLogger } from "../lib/logger";
import { appFetch } from "../lib/public-path";
import { DEFAULT_QUICK_CHAT_SETTINGS, type QuickChatSettings } from "@/shared/preferences";
import { normalizeQuickChatSettings } from "@/contracts/schemas";

const log = createLogger("useQuickChatSettings");

async function parsePreferenceError(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json() as { message?: string; error?: string };
    return data.message ?? data.error ?? fallback;
  } catch {
    return fallback;
  }
}

export interface UseQuickChatSettingsResult {
  settings: QuickChatSettings;
  loading: boolean;
  saving: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  updateSettings: (settings: QuickChatSettings) => Promise<QuickChatSettings | null>;
}

export function useQuickChatSettings(): UseQuickChatSettingsResult {
  const [settings, setSettings] = useState<QuickChatSettings>(DEFAULT_QUICK_CHAT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const isActiveRequest = () => abortControllerRef.current === controller && requestIdRef.current === requestId;

    try {
      setLoading(true);
      setError(null);
      const response = await appFetch("/api/preferences/quick-chat", { signal: controller.signal });
      if (controller.signal.aborted || !isActiveRequest()) {
        return;
      }
      if (!response.ok) {
        throw new Error(await parsePreferenceError(response, "Failed to load quick chat settings"));
      }
      const nextSettings = normalizeQuickChatSettings(await response.json());
      if (controller.signal.aborted || !isActiveRequest()) {
        return;
      }
      setSettings(nextSettings);
    } catch (refreshError) {
      if (refreshError instanceof DOMException && refreshError.name === "AbortError") {
        return;
      }
      if (!isActiveRequest()) {
        return;
      }
      log.warn("Failed to load quick chat settings", { error: String(refreshError) });
      setError(String(refreshError));
      setSettings(DEFAULT_QUICK_CHAT_SETTINGS);
    } finally {
      if (!controller.signal.aborted && isActiveRequest()) {
        setLoading(false);
      }
    }
  }, []);

  const updateSettings = useCallback(async (nextSettings: QuickChatSettings): Promise<QuickChatSettings | null> => {
    const normalizedSettings = normalizeQuickChatSettings(nextSettings);
    try {
      setSaving(true);
      setError(null);
      const response = await appFetch("/api/preferences/quick-chat", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(normalizedSettings),
      });
      if (!response.ok) {
        throw new Error(await parsePreferenceError(response, "Failed to save quick chat settings"));
      }
      const body = await response.json() as { settings?: unknown };
      const savedSettings = normalizeQuickChatSettings(body.settings ?? normalizedSettings);
      setSettings(savedSettings);
      return savedSettings;
    } catch (saveError) {
      log.error("Failed to save quick chat settings", { error: String(saveError) });
      setError(String(saveError));
      return null;
    } finally {
      setSaving(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      abortControllerRef.current?.abort();
    };
  }, [refresh]);

  return {
    settings,
    loading,
    saving,
    error,
    refresh,
    updateSettings,
  };
}
