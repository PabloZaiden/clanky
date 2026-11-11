import { useCallback, useEffect, useSyncExternalStore } from "react";
import { apiRequest } from "../lib/api-client";
import { createRefreshCoordinator } from "../lib/refresh-coordinator";
import { createLiveVoiceValidationOffer } from "../lib/live-voice-browser";
import { getClientSession, subscribeClientSession } from "@/platform/web/client-session";
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
      transcription: "",
      text: "",
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
      text: {
        configured: false,
        validated: false,
        state: "unconfigured",
        checkedAt: null,
        error: null,
      },
      live: {
        configured: false,
        validated: false,
        state: "unconfigured",
        checkedAt: null,
        error: null,
      },
    },
    piper: { available: false },
    live: {
      useVoiceProvider: true,
      baseUrl: "",
      apiKeyConfigured: false,
      model: "",
      personalInstructions: "",
      configured: false,
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

subscribeClientSession(() => {
  if (!getClientSession().demo) return;
  refreshController?.abort();
  refreshController = null;
  refreshCoordinator.reset();
  updateState({ settings: createDefaultSettings(), loading: true, saving: false, validating: null, error: null });
});

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
      if (controller.signal.aborted) return;
      updateState({ settings: next, error: null });
    } catch (refreshError) {
      if (controller.signal.aborted) return;
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

export function useVoiceSettings({ enabled = true }: { enabled?: boolean } = {}): UseVoiceSettingsResult {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (enabled) void refreshVoiceSettings();
  }, [enabled]);

  const updateSettings = useCallback(async (
    update: VoiceSettingsUpdate,
  ): Promise<VoiceSettings> => {
    const generation = getClientSession().generation;
    updateState({ saving: true });
    try {
      const next = await apiRequest<VoiceSettings>("/api/voice/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
        action: "Save voice settings",
        fallbackMessage: "Failed to save voice settings",
      });
      if (generation === getClientSession().generation) updateState({ settings: next, error: null });
      return next;
    } catch (saveError) {
      if (generation === getClientSession().generation) updateState({ error: String(saveError) });
      throw saveError;
    } finally {
      if (generation === getClientSession().generation) updateState({ saving: false });
    }
  }, []);

  const validateCapability = useCallback(async (
    capability: VoiceCapability,
  ): Promise<VoiceSettings> => {
    if (getClientSession().demo) throw new Error("Demo: voice providers and microphone validation are not simulated.");
    const generation = getClientSession().generation;
    updateState({ validating: capability });
    const signal = AbortSignal.timeout(30_000);
    try {
      const sdp = capability === "live"
        ? await createLiveVoiceValidationOffer(signal)
        : undefined;
      if (generation !== getClientSession().generation) throw new Error("The client session changed.");
      const result = await apiRequest<{ settings: VoiceSettings }>("/api/voice/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability, ...(sdp ? { sdp } : {}) }),
        signal,
        action: `Validate ${capability} voice capability`,
        fallbackMessage: `Failed to validate ${capability} voice capability`,
      });
      if (generation === getClientSession().generation) updateState({ settings: result.settings, error: null });
      return result.settings;
    } catch (validationError) {
      if (generation === getClientSession().generation) {
        await refreshVoiceSettings();
        updateState({ error: String(validationError) });
      }
      throw validationError;
    } finally {
      if (generation === getClientSession().generation) updateState({ validating: null });
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
