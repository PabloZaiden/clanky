import { useEffect, useRef, useState } from "react";
import type {
  LiveVoiceSettings,
  VoiceLanguageHint,
  VoiceSettings,
} from "@/shared";
import type { UseVoiceSettingsResult } from "../../hooks";
import { Button } from "../common";
import { SettingsCheckbox, SettingsInput } from "./settings-row-controls";

function toDraft(settings: LiveVoiceSettings) {
  return {
    useVoiceProvider: settings.useVoiceProvider,
    baseUrl: settings.baseUrl,
    apiKey: "",
    clearApiKey: false,
  };
}

export function LiveVoiceSettingsRowContent({
  voiceSettings,
  model,
  providerDraft,
  onDraftDirtyChange,
  onProviderSettingsSaved,
}: {
  voiceSettings: UseVoiceSettingsResult;
  model: string;
  providerDraft: {
    baseUrl: string;
    apiKey: string;
    clearApiKey: boolean;
    models: VoiceSettings["models"];
    languageHints: VoiceLanguageHint[];
  };
  onDraftDirtyChange: (dirty: boolean) => void;
  onProviderSettingsSaved: (settings: VoiceSettings) => void;
}) {
  const { settings, loading, saving } = voiceSettings;
  const [draft, setDraft] = useState(() => toDraft(settings.live));
  const synced = useRef(JSON.stringify(toDraft(settings.live)));
  const current = useRef(draft);
  current.current = draft;
  const draftIsDirty = JSON.stringify({ ...draft, apiKey: "", clearApiKey: false }) !== synced.current
    || draft.apiKey.length > 0
    || draft.clearApiKey;

  useEffect(() => {
    const next = toDraft(settings.live);
    if (JSON.stringify(current.current) === synced.current) setDraft(next);
    synced.current = JSON.stringify(next);
  }, [settings.live]);

  useEffect(() => {
    onDraftDirtyChange(draftIsDirty);
  }, [draftIsDirty, onDraftDirtyChange]);

  async function save(): Promise<void> {
    try {
      const saved = await voiceSettings.updateSettings({
        baseUrl: providerDraft.baseUrl,
        apiKey: providerDraft.apiKey || undefined,
        clearApiKey: providerDraft.clearApiKey,
        models: providerDraft.models,
        languageHints: providerDraft.languageHints,
        live: { ...draft, model, apiKey: draft.apiKey || undefined },
      });
      const next = toDraft(saved.live);
      synced.current = JSON.stringify(next);
      setDraft(next);
      onProviderSettingsSaved(saved);
    } catch {
      // The hook exposes save errors through the shared settings error state.
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-gray-200 p-3 dark:border-gray-700">
      <p className="text-xs font-medium">Live voice connection</p>
      <div className="flex items-center gap-2">
        <SettingsCheckbox
          id="live-use-voice-provider"
          ariaLabel="Reuse voice provider for Live"
          checked={draft.useVoiceProvider}
          disabled={loading || saving}
          onChange={(event) => {
            const useVoiceProvider = event.currentTarget.checked;
            setDraft((value) => ({ ...value, useVoiceProvider }));
          }}
        />
        <label htmlFor="live-use-voice-provider" className="text-sm">Use the voice provider URL and saved key</label>
      </div>
      {!draft.useVoiceProvider ? (
        <>
          <label htmlFor="live-base-url" className="block text-xs font-medium">Live base URL</label>
          <SettingsInput
            id="live-base-url"
            autoComplete="url"
            value={draft.baseUrl}
            placeholder="https://api.openai.com/v1"
            disabled={loading || saving}
            onChange={(event) => {
              const baseUrl = event.currentTarget.value;
              setDraft((value) => ({ ...value, baseUrl }));
            }}
          />
          <label htmlFor="live-api-key" className="block text-xs font-medium">Live API key</label>
          <SettingsInput
            id="live-api-key"
            type="password"
            autoComplete="new-password"
            value={draft.apiKey}
            placeholder={settings.live.apiKeyConfigured ? "Saved key; leave blank to keep it" : "Provider API key"}
            disabled={loading || saving}
            onChange={(event) => {
              const apiKey = event.currentTarget.value;
              setDraft((value) => ({ ...value, apiKey, clearApiKey: false }));
            }}
          />
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={loading || saving}
            onClick={() => setDraft((value) => ({ ...value, apiKey: "", clearApiKey: true }))}
          >
            Clear saved Live key
          </Button>
        </>
      ) : null}
      <Button type="button" size="sm" variant="primary" disabled={loading || saving} loading={saving} onClick={() => void save()}>Save Live settings</Button>
      <p className="text-xs text-gray-500 dark:text-gray-400">{settings.live.configured ? "Configured" : "Not configured"}</p>
    </div>
  );
}
