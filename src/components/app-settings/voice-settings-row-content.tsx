import { useEffect, useRef, useState } from "react";
import {
  VOICE_CAPABILITIES,
  VOICE_LANGUAGE_HINTS,
  type VoiceCapability,
  type VoiceLanguageHint,
  type VoiceSettings,
} from "@/shared";
import type { UseVoiceSettingsResult } from "../../hooks";
import { Button } from "../common";
import { SettingsCheckbox, SettingsError, SettingsInput } from "./settings-row-controls";
import { LiveVoiceSettingsRowContent } from "./live-voice-settings-row-content";

interface VoiceSettingsDraft {
  baseUrl: string;
  apiKey: string;
  transcription: string;
  text: string;
  liveModel: string;
  languageHints: VoiceLanguageHint[];
}

function toDraft(settings: VoiceSettings): VoiceSettingsDraft {
  return {
    baseUrl: settings.baseUrl,
    apiKey: "",
    transcription: settings.models.transcription,
    text: settings.models.text,
    liveModel: settings.live.model,
    languageHints: settings.languageHints,
  };
}

function providerDraftValuesMatch(left: VoiceSettingsDraft, right: VoiceSettingsDraft): boolean {
  return left.baseUrl === right.baseUrl
    && left.transcription === right.transcription
    && left.text === right.text
    && left.languageHints.join(",") === right.languageHints.join(",");
}

function draftValuesMatch(left: VoiceSettingsDraft, right: VoiceSettingsDraft): boolean {
  return providerDraftValuesMatch(left, right)
    && left.liveModel === right.liveModel;
}

function capabilityLabel(capability: VoiceCapability): string {
  if (capability === "transcription") return "Transcription";
  if (capability === "text") return "Text generation";
  return "Live Voice";
}

export function VoiceSettingsRowContent({
  voiceSettings,
}: {
  voiceSettings: UseVoiceSettingsResult;
}) {
  const { settings, loading, saving, validating, error } = voiceSettings;
  const [draft, setDraft] = useState<VoiceSettingsDraft>(() => toDraft(settings));
  const draftRef = useRef(draft);
  const lastSyncedDraftRef = useRef<VoiceSettingsDraft>(toDraft(settings));
  const [clearApiKey, setClearApiKey] = useState(false);
  const [liveSettingsDraftIsDirty, setLiveSettingsDraftIsDirty] = useState(false);
  draftRef.current = draft;
  const providerDraftIsDirty = !providerDraftValuesMatch(
    draft,
    lastSyncedDraftRef.current,
  )
    || draft.apiKey.length > 0
    || clearApiKey;
  const liveModelDraftIsDirty = draft.liveModel !== lastSyncedDraftRef.current.liveModel;

  function syncSavedSettings(savedSettings: VoiceSettings): void {
    const savedDraft = toDraft(savedSettings);
    lastSyncedDraftRef.current = savedDraft;
    setDraft({ ...savedDraft, apiKey: "" });
    setClearApiKey(false);
  }

  useEffect(() => {
    const nextSyncedDraft = toDraft(settings);
    const currentDraft = draftRef.current;
    const currentDraftIsDirty = !draftValuesMatch(
      currentDraft,
      lastSyncedDraftRef.current,
    ) || currentDraft.apiKey.length > 0 || clearApiKey;
    lastSyncedDraftRef.current = nextSyncedDraft;
    if (currentDraftIsDirty) {
      return;
    }
    setDraft((current) => ({
      ...nextSyncedDraft,
      apiKey: current.apiKey,
    }));
  }, [clearApiKey, settings]);

  async function save(): Promise<void> {
    try {
      const savedSettings = await voiceSettings.updateSettings({
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey || undefined,
        clearApiKey,
        models: {
          transcription: draft.transcription,
          text: draft.text,
        },
        languageHints: draft.languageHints,
        live: {
          useVoiceProvider: settings.live.useVoiceProvider,
          baseUrl: settings.live.baseUrl,
          model: draft.liveModel,
        },
      });
      syncSavedSettings(savedSettings);
    } catch {
      // The hook exposes save errors through the shared settings error state.
    }
  }

  function toggleLanguageHint(language: VoiceLanguageHint, checked: boolean): void {
    setDraft((current) => ({
      ...current,
      languageHints: checked
        ? Array.from(new Set([...current.languageHints, language]))
        : current.languageHints.filter((hint) => hint !== language),
    }));
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="voice-base-url" className="block text-xs font-medium">Base URL</label>
        <SettingsInput
          id="voice-base-url"
          value={draft.baseUrl}
          placeholder="https://...openai.azure.com"
          autoComplete="url"
          disabled={loading || saving}
          onChange={(event) => {
            const baseUrl = event.currentTarget.value;
            setDraft((current) => ({ ...current, baseUrl }));
          }}
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="voice-api-key" className="block text-xs font-medium">API key</label>
        <SettingsInput
          id="voice-api-key"
          type="password"
          value={draft.apiKey}
          placeholder={settings.apiKeyConfigured ? "Saved key; leave blank to keep it" : "Provider API key"}
          autoComplete="new-password"
          disabled={loading || saving}
          onChange={(event) => {
            const apiKey = event.currentTarget.value;
            setClearApiKey(false);
            setDraft((current) => ({ ...current, apiKey }));
          }}
        />
        {settings.apiKeyConfigured ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={loading || saving}
            onClick={() => {
              setDraft((current) => ({ ...current, apiKey: "" }));
              setClearApiKey(true);
            }}
          >
            Clear saved API key
          </Button>
        ) : null}
      </div>
      <div className="space-y-2 rounded-md border border-gray-200 p-3 dark:border-gray-700">
        <p className="text-xs font-medium">Models</p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <div className="space-y-1">
            <label htmlFor="voice-transcription-model" className="block text-xs font-medium">Transcription model</label>
            <SettingsInput
              id="voice-transcription-model"
              value={draft.transcription}
              disabled={loading || saving}
              onChange={(event) => {
                const transcription = event.currentTarget.value;
                setDraft((current) => ({ ...current, transcription }));
              }}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="voice-text-model" className="block text-xs font-medium">Text generation model</label>
            <SettingsInput
              id="voice-text-model"
              value={draft.text}
              disabled={loading || saving}
              onChange={(event) => {
                const text = event.currentTarget.value;
                setDraft((current) => ({ ...current, text }));
              }}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="live-model" className="block text-xs font-medium">Live Voice model / deployment</label>
            <SettingsInput
              id="live-model"
              value={draft.liveModel}
              disabled={loading || saving}
              onChange={(event) => {
                const liveModel = event.currentTarget.value;
                setDraft((current) => ({ ...current, liveModel }));
              }}
            />
          </div>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Text generation is shared by summaries and Live Voice.
        </p>
      </div>
      <div className="space-y-1 rounded-md border border-gray-200 p-3 dark:border-gray-700">
        <p className="text-xs font-medium">Local text to speech</p>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          Piper uses Argentina Spanish and US English voices. The runtime and
          selected voice download on first use and stay in Clanky&apos;s data directory.
        </p>
        <p className="text-sm">
          {settings.piper.available
            ? "Supported on this server"
            : "Not supported on this server"}
        </p>
      </div>
      <div className="space-y-1">
        <p className="text-xs font-medium">Language hints</p>
        <div className="flex flex-wrap gap-4">
          {VOICE_LANGUAGE_HINTS.map((language) => (
            <div key={language} className="flex items-start gap-2">
              <SettingsCheckbox
                id={`voice-language-hint-${language}`}
                ariaLabel={`Voice language hint ${language}`}
                checked={draft.languageHints.includes(language)}
                disabled={loading || saving}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  toggleLanguageHint(language, checked);
                }}
              />
              <label htmlFor={`voice-language-hint-${language}`} className="text-sm">
                {language}
              </label>
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="primary"
          loading={saving}
          disabled={loading || saving}
          onClick={() => void save()}
        >
          Save provider settings
        </Button>
      </div>
      <div className="space-y-2 rounded-md border border-gray-200 p-3 dark:border-gray-700">
        <p className="text-xs font-medium">Capability validation</p>
        {VOICE_CAPABILITIES.map((capability) => {
          const capabilityStatus = settings.capabilities[capability];
          const isValidating = validating === capability;
          const capabilityDraftIsDirty = capability === "live"
            ? providerDraftIsDirty || liveModelDraftIsDirty || liveSettingsDraftIsDirty
            : providerDraftIsDirty;
          return (
            <div key={capability} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                {capabilityLabel(capability)}:{" "}
                <span className="text-gray-500 dark:text-gray-400">
                  {capabilityStatus.validated
                    ? "validated"
                    : capabilityStatus.configured
                        ? `${capabilityStatus.state}${capabilityStatus.error ? `: ${capabilityStatus.error}` : ""}`
                      : "not configured"}
                </span>
              </span>
              <Button
                type="button"
                size="xs"
                variant="secondary"
                loading={isValidating}
                disabled={
                  loading
                  || saving
                  || validating !== null
                  || capabilityDraftIsDirty
                  || !capabilityStatus.configured
                }
                onClick={() => void voiceSettings.validateCapability(capability)}
              >
                Validate
              </Button>
            </div>
          );
        })}
      </div>
      <LiveVoiceSettingsRowContent
        voiceSettings={voiceSettings}
        model={draft.liveModel}
        providerDraft={{
          baseUrl: draft.baseUrl,
          apiKey: draft.apiKey,
          clearApiKey,
          models: {
            transcription: draft.transcription,
            text: draft.text,
          },
          languageHints: draft.languageHints,
        }}
        onDraftDirtyChange={setLiveSettingsDraftIsDirty}
        onProviderSettingsSaved={syncSavedSettings}
      />
      {error ? <SettingsError>{error}</SettingsError> : null}
    </div>
  );
}
