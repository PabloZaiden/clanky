import { useCallback, useEffect, useRef, useState } from "react";
import { createLogger } from "../lib/logger";
import { appFetch } from "../lib/public-path";
import {
  DEFAULT_QUICK_CHAT_SETTINGS,
  type QuickChatSettings,
} from "../types/preferences";
import { ModelConfigSchema } from "../types/schemas/model";

const log = createLogger("useQuickChatSettings");

function normalizeQuickChatSettings(value: unknown): QuickChatSettings {
  if (!value || typeof value !== "object") {
    return DEFAULT_QUICK_CHAT_SETTINGS;
  }

  const candidate = value as Record<string, unknown>;
  const workspaceId = typeof candidate["workspaceId"] === "string"
    ? candidate["workspaceId"].trim()
    : "";
  const modelValidation = ModelConfigSchema.nullable().safeParse(candidate["model"] ?? null);

  return {
    workspaceId,
    model: modelValidation.success ? modelValidation.data : null,
  };
}

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

  const refresh = useCallback(async () => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      setLoading(true);
      setError(null);
      const response = await appFetch("/api/preferences/quick-chat", { signal: controller.signal });
      if (controller.signal.aborted) {
        return;
      }
      if (!response.ok) {
        throw new Error(await parsePreferenceError(response, "Failed to load quick chat settings"));
      }
      setSettings(normalizeQuickChatSettings(await response.json()));
    } catch (refreshError) {
      if (refreshError instanceof DOMException && refreshError.name === "AbortError") {
        return;
      }
      log.warn("Failed to load quick chat settings", { error: String(refreshError) });
      setError(String(refreshError));
      setSettings(DEFAULT_QUICK_CHAT_SETTINGS);
    } finally {
      if (!controller.signal.aborted) {
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
