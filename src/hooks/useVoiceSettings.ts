import { useCallback, useEffect, useSyncExternalStore } from "react";
import { apiRequest } from "../lib/api-client";
import { createRefreshCoordinator } from "../lib/refresh-coordinator";
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

interface VoiceSettingsStoreState {
  settings: VoiceSettings;
  loading: boolean;
  saving: boolean;
  validating: VoiceCapability | null;
  error: string | null;
}

const listeners = new Set<() => void>();
const refreshCoordinator = createRefreshCoordinator<void>();
let refreshController: AbortController | null = null;
let subscriberCount = 0;
let state: VoiceSettingsStoreState = {
  settings: createDefaultSettings(),
  loading: true,
  saving: false,
  validating: null,
  error: null,
};

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function updateState(patch: Partial<VoiceSettingsStoreState>): void {
  state = { ...state, ...patch };
  emit();
}

async function refreshVoiceSettings(): Promise<void> {
  await refreshCoordinator.run(async () => {
    const controller = new AbortController();
    refreshController = controller;
    updateState({ loading: true });
    try {
      const next = await apiRequest<VoiceSettings>("/api/voice/settings", {
        signal: controller.signal,
        action: "Load voice settings",
        fallbackMessage: "Failed to load voice settings",
      });
      updateState({ settings: next, error: null });
    } catch (refreshError) {
      if (!(refreshError instanceof Error && refreshError.name === "AbortError")) {
        updateState({ error: String(refreshError) });
      }
    } finally {
      if (refreshController === controller) {
        refreshController = null;
        updateState({ loading: false });
      }
    }
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  subscriberCount += 1;
  return () => {
    listeners.delete(listener);
    subscriberCount = Math.max(0, subscriberCount - 1);
    if (subscriberCount === 0 && refreshController) {
      refreshController.abort();
      refreshController = null;
      refreshCoordinator.reset();
    }
  };
}

function getSnapshot(): VoiceSettingsStoreState {
  return state;
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
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    void refreshVoiceSettings();
  }, []);

  const updateSettings = useCallback(async (
    update: VoiceSettingsUpdate,
  ): Promise<VoiceSettings> => {
    updateState({ saving: true });
    try {
      const next = await apiRequest<VoiceSettings>("/api/voice/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
        action: "Save voice settings",
        fallbackMessage: "Failed to save voice settings",
      });
      updateState({ settings: next, error: null });
      return next;
    } catch (saveError) {
      updateState({ error: String(saveError) });
      throw saveError;
    } finally {
      updateState({ saving: false });
    }
  }, []);

  const validateCapability = useCallback(async (
    capability: VoiceCapability,
  ): Promise<VoiceSettings> => {
    updateState({ validating: capability });
    try {
      const result = await apiRequest<{ settings: VoiceSettings }>("/api/voice/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability }),
        action: `Validate ${capability} voice capability`,
        fallbackMessage: `Failed to validate ${capability} voice capability`,
      });
      updateState({ settings: result.settings, error: null });
      return result.settings;
    } catch (validationError) {
      await refreshVoiceSettings();
      updateState({ error: String(validationError) });
      throw validationError;
    } finally {
      updateState({ validating: null });
    }
  }, []);

  return {
    settings: snapshot.settings,
    loading: snapshot.loading,
    saving: snapshot.saving,
    validating: snapshot.validating,
    error: snapshot.error,
    refresh: refreshVoiceSettings,
    updateSettings,
    validateCapability,
  };
}
