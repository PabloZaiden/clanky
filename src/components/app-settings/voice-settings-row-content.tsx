import { useEffect, useState } from "react";
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

interface VoiceSettingsDraft {
  baseUrl: string;
  apiKey: string;
  transcription: string;
  speech: string;
  text: string;
  languageHints: VoiceLanguageHint[];
}

function toDraft(settings: VoiceSettings): VoiceSettingsDraft {
  return {
    baseUrl: settings.baseUrl,
    apiKey: "",
    transcription: settings.models.transcription,
    speech: settings.models.speech,
    text: settings.models.text,
    languageHints: settings.languageHints,
  };
}

function capabilityLabel(capability: VoiceCapability): string {
  if (capability === "transcription") return "Transcription";
  if (capability === "speech") return "Text to speech";
  return "General text";
}

export function VoiceSettingsRowContent({
  voiceSettings,
}: {
  voiceSettings: UseVoiceSettingsResult;
}) {
  const { settings, loading, saving, validating, error } = voiceSettings;
  const [draft, setDraft] = useState<VoiceSettingsDraft>(() => toDraft(settings));
  const [clearApiKey, setClearApiKey] = useState(false);
  const draftIsDirty = draft.baseUrl !== settings.baseUrl
    || draft.transcription !== settings.models.transcription
    || draft.speech !== settings.models.speech
    || draft.text !== settings.models.text
    || draft.languageHints.join(",") !== settings.languageHints.join(",")
    || draft.apiKey.length > 0
    || clearApiKey;

  useEffect(() => {
    if (draftIsDirty) {
      return;
    }
    setDraft((current) => ({
      ...toDraft(settings),
      apiKey: current.apiKey,
    }));
  }, [draftIsDirty, settings]);

  async function save(): Promise<void> {
    await voiceSettings.updateSettings({
      baseUrl: draft.baseUrl,
      apiKey: draft.apiKey || undefined,
      clearApiKey,
      models: {
        transcription: draft.transcription,
        speech: draft.speech,
        text: draft.text,
      },
      languageHints: draft.languageHints,
    });
    setDraft((current) => ({ ...current, apiKey: "" }));
    setClearApiKey(false);
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
          onChange={(event) => setDraft((current) => ({
            ...current,
            baseUrl: event.currentTarget.value,
          }))}
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
            setClearApiKey(false);
            setDraft((current) => ({ ...current, apiKey: event.currentTarget.value }));
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
      <div className="grid gap-2 sm:grid-cols-3">
        <div>
          <label htmlFor="voice-transcription-model" className="block text-xs font-medium">STT model</label>
          <SettingsInput
            id="voice-transcription-model"
            value={draft.transcription}
            disabled={loading || saving}
            onChange={(event) => setDraft((current) => ({
              ...current,
              transcription: event.currentTarget.value,
            }))}
          />
        </div>
        <div>
          <label htmlFor="voice-speech-model" className="block text-xs font-medium">TTS model</label>
          <SettingsInput
            id="voice-speech-model"
            value={draft.speech}
            disabled={loading || saving}
            onChange={(event) => setDraft((current) => ({
              ...current,
              speech: event.currentTarget.value,
            }))}
          />
        </div>
        <div>
          <label htmlFor="voice-text-model" className="block text-xs font-medium">Text model</label>
          <SettingsInput
            id="voice-text-model"
            value={draft.text}
            disabled={loading || saving}
            onChange={(event) => setDraft((current) => ({
              ...current,
              text: event.currentTarget.value,
            }))}
          />
        </div>
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
                onChange={(event) => toggleLanguageHint(language, event.currentTarget.checked)}
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
                  || draftIsDirty
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
      {error ? <SettingsError>{error}</SettingsError> : null}
    </div>
  );
}
