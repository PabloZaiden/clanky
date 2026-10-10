import { useEffect, useRef, useState } from "react";
import type { LiveVoiceSettings } from "@/shared";
import type { UseVoiceSettingsResult } from "../../hooks";
import { Button } from "../common";
import { SettingsCheckbox, SettingsInput } from "./settings-row-controls";

function toDraft(settings: LiveVoiceSettings) {
  return {
    useVoiceProvider: settings.useVoiceProvider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    textModel: settings.textModel,
    apiKey: "",
    clearApiKey: false,
  };
}

export function LiveVoiceSettingsRowContent({ voiceSettings }: { voiceSettings: UseVoiceSettingsResult }) {
  const { settings, loading, saving } = voiceSettings;
  const [draft, setDraft] = useState(() => toDraft(settings.live));
  const synced = useRef(JSON.stringify(toDraft(settings.live)));
  const current = useRef(draft);
  current.current = draft;
  useEffect(() => {
    const next = toDraft(settings.live);
    if (JSON.stringify(current.current) === synced.current) setDraft(next);
    synced.current = JSON.stringify(next);
  }, [settings.live]);
  async function save(): Promise<void> {
    try {
      const saved = await voiceSettings.updateSettings({
        baseUrl: settings.baseUrl, models: settings.models, languageHints: settings.languageHints,
        live: { ...draft, apiKey: draft.apiKey || undefined },
      });
      const next = toDraft(saved.live);
      synced.current = JSON.stringify(next);
      setDraft(next);
    } catch {
      // The shared settings error is rendered by the parent row.
    }
  }
  return (
    <div className="space-y-3 rounded-md border border-gray-200 p-3 dark:border-gray-700">
      <p className="text-xs font-medium">Live voice</p>
      <div className="flex items-center gap-2">
        <SettingsCheckbox id="live-use-voice-provider" ariaLabel="Reuse voice provider for Live" checked={draft.useVoiceProvider}
          disabled={loading || saving} onChange={(event) => setDraft((value) => ({ ...value, useVoiceProvider: event.currentTarget.checked }))} />
        <label htmlFor="live-use-voice-provider" className="text-sm">Use the voice provider URL and saved key</label>
      </div>
      {!draft.useVoiceProvider ? (
        <>
          <label htmlFor="live-base-url" className="block text-xs font-medium">Live base URL</label>
          <SettingsInput id="live-base-url" autoComplete="url" value={draft.baseUrl} placeholder="https://api.openai.com/v1"
            disabled={loading || saving} onChange={(event) => setDraft((value) => ({ ...value, baseUrl: event.currentTarget.value }))} />
          <label htmlFor="live-api-key" className="block text-xs font-medium">Live API key</label>
          <SettingsInput id="live-api-key" type="password" autoComplete="new-password" value={draft.apiKey}
            placeholder={settings.live.apiKeyConfigured ? "Saved key; leave blank to keep it" : "Provider API key"}
            disabled={loading || saving} onChange={(event) => setDraft((value) => ({ ...value, apiKey: event.currentTarget.value, clearApiKey: false }))} />
          <Button type="button" size="xs" variant="ghost" disabled={loading || saving} onClick={() => setDraft((value) => ({ ...value, apiKey: "", clearApiKey: true }))}>Clear saved Live key</Button>
        </>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="live-model" className="block text-xs font-medium">Live model / deployment</label>
          <SettingsInput id="live-model" value={draft.model} disabled={loading || saving}
            onChange={(event) => setDraft((value) => ({ ...value, model: event.currentTarget.value }))} />
        </div>
        <div className="space-y-1">
          <label htmlFor="live-text-model" className="block text-xs font-medium">Delegated Responses model / deployment</label>
          <SettingsInput id="live-text-model" value={draft.textModel} placeholder={settings.models.text}
            disabled={loading || saving} onChange={(event) => setDraft((value) => ({ ...value, textModel: event.currentTarget.value }))} />
        </div>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">Both models must be available at the Live endpoint. Leave the delegated model blank to use the text model above.</p>
      <Button type="button" size="sm" variant="primary" disabled={loading || saving} loading={saving} onClick={() => void save()}>Save Live settings</Button>
      <p className="text-xs text-gray-500 dark:text-gray-400">{settings.live.configured ? "Configured. Session and sideband are checked on call start; the delegated model is checked when used." : "Not configured"}</p>
    </div>
  );
}
