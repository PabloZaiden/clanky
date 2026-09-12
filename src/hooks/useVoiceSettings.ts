import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "../lib/api-client";
import {
  DEFAULT_VOICE_LANGUAGE_HINTS,
} from "@/shared";
import type {
  VoiceCapability,
  VoiceSettings,
  VoiceSettingsUpdate,
} from "@/shared";

function createDefaultSettings(): VoiceSettings {
  return {
    baseUrl: "",
    apiKeyConfigured: false,
    models: {
      transcription: "gpt-transcribe",
      speech: "tts",
      text: "gpt-5.6-luna",
    },
    languageHints: [...DEFAULT_VOICE_LANGUAGE_HINTS],
    capabilities: {
      transcription: {
        configured: false,
        validated: false,
        state: "unconfigured",
        checkedAt: null,
        error: null,
      },
      speech: {
        configured: false,
        validated: false,
        state: "unconfigured",
        checkedAt: null,
        error: null,
      },
      text: {
        configured: false,
        validated: false,
        state: "unconfigured",
        checkedAt: null,
        error: null,
      },
    },
  };
}

export interface UseVoiceSettingsResult {
  settings: VoiceSettings;
  loading: boolean;
  saving: boolean;
  validating: VoiceCapability | null;
  error: string | null;
  refresh: () => Promise<void>;
  updateSettings: (update: VoiceSettingsUpdate) => Promise<VoiceSettings>;
  validateCapability: (capability: VoiceCapability) => Promise<VoiceSettings>;
}

export function useVoiceSettings(): UseVoiceSettingsResult {
  const [settings, setSettings] = useState<VoiceSettings>(createDefaultSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState<VoiceCapability | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshControllerRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    refreshControllerRef.current?.abort();
    const controller = new AbortController();
    refreshControllerRef.current = controller;
    setLoading(true);
    try {
      const next = await apiRequest<VoiceSettings>("/api/voice/settings", {
        signal: controller.signal,
        action: "Load voice settings",
        fallbackMessage: "Failed to load voice settings",
      });
      setSettings(next);
      setError(null);
    } catch (refreshError) {
      if (refreshError instanceof Error && refreshError.name === "AbortError") {
        return;
      }
      setError(String(refreshError));
    } finally {
      if (refreshControllerRef.current === controller) {
        refreshControllerRef.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
    };
  }, [refresh]);

  const updateSettings = useCallback(async (
    update: VoiceSettingsUpdate,
  ): Promise<VoiceSettings> => {
    setSaving(true);
    try {
      const next = await apiRequest<VoiceSettings>("/api/voice/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
        action: "Save voice settings",
        fallbackMessage: "Failed to save voice settings",
      });
      setSettings(next);
      setError(null);
      return next;
    } catch (saveError) {
      setError(String(saveError));
      throw saveError;
    } finally {
      setSaving(false);
    }
  }, []);

  const validateCapability = useCallback(async (
    capability: VoiceCapability,
  ): Promise<VoiceSettings> => {
    setValidating(capability);
    try {
      const result = await apiRequest<{ settings: VoiceSettings }>("/api/voice/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability }),
        action: `Validate ${capability} voice capability`,
        fallbackMessage: `Failed to validate ${capability} voice capability`,
      });
      setSettings(result.settings);
      setError(null);
      return result.settings;
    } catch (validationError) {
      setError(String(validationError));
      try {
        await refresh();
      } catch {
        // The validation error is already visible; refresh is best effort.
      }
      throw validationError;
    } finally {
      setValidating(null);
    }
  }, [refresh]);

  return {
    settings,
    loading,
    saving,
    validating,
    error,
    refresh,
    updateSettings,
    validateCapability,
  };
}
