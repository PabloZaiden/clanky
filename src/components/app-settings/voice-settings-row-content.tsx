import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Button,
  CheckboxField,
  FormActions,
  FormGroup,
  Input,
  LoadingState,
  SettingsFieldRow,
  TextAreaField,
  TextField,
  useUnsavedChanges,
} from "@pablozaiden/webapp/web";
import {
  VOICE_CAPABILITIES,
  LIVE_VOICE_MAX_PERSONAL_INSTRUCTIONS_CHARS,
  VOICE_LANGUAGE_HINTS,
  type VoiceCapability,
  type VoiceLanguageHint,
  type VoiceSettings,
} from "@/shared";
import type { UseVoiceSettingsResult } from "../../hooks";
import { SettingsError } from "./settings-row-controls";

function toDraft(settings: VoiceSettings) {
  return {
    baseUrl: settings.baseUrl,
    apiKey: "",
    clearApiKey: false,
    transcription: settings.models.transcription,
    text: settings.models.text,
    languageHints: settings.languageHints,
    liveModel: settings.live.model,
    livePersonalInstructions: settings.live.personalInstructions,
    liveUseVoiceProvider: settings.live.useVoiceProvider,
    liveBaseUrl: settings.live.baseUrl,
    liveApiKey: "",
    clearLiveApiKey: false,
  };
}

const CAPABILITY_LABELS: Record<VoiceCapability, string> = {
  transcription: "Transcription",
  text: "Text generation",
  live: "Live Voice",
};

export function VoiceSettingsRowContent({ voiceSettings }: { voiceSettings: UseVoiceSettingsResult }) {
  const { settings, loading, saving, validating, error } = voiceSettings;
  const [draft, setDraft] = useState(() => toDraft(settings));
  const current = useRef(draft);
  const synced = useRef(JSON.stringify(toDraft(settings)));
  current.current = draft;
  const dirty = JSON.stringify(draft) !== synced.current;
  const busy = loading || saving || validating !== null;
  function updateDraft(patch: Partial<ReturnType<typeof toDraft>>): void {
    setDraft((value) => ({ ...value, ...patch }));
  }
  function resetDraft(): void {
    const next = toDraft(settings);
    synced.current = JSON.stringify(next);
    setDraft(next);
  }
  useUnsavedChanges(dirty, resetDraft);

  useEffect(() => {
    const next = toDraft(settings);
    if (JSON.stringify(current.current) === synced.current) setDraft(next);
    synced.current = JSON.stringify(next);
  }, [settings]);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    try {
      const saved = await voiceSettings.updateSettings({
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey || undefined,
        clearApiKey: draft.clearApiKey,
        models: { transcription: draft.transcription, text: draft.text },
        languageHints: draft.languageHints,
        live: {
          useVoiceProvider: draft.liveUseVoiceProvider,
          baseUrl: draft.liveBaseUrl,
          apiKey: draft.liveApiKey || undefined,
          clearApiKey: draft.clearLiveApiKey,
          model: draft.liveModel,
          personalInstructions: draft.livePersonalInstructions,
        },
      });
      const next = toDraft(saved);
      synced.current = JSON.stringify(next);
      setDraft(next);
    } catch {
      // The shared hook exposes the failure inline and retains this draft.
    }
  }

  async function validate(capability: VoiceCapability): Promise<void> {
    try {
      await voiceSettings.validateCapability(capability);
    } catch {
      // The shared hook exposes provider and browser validation failures.
    }
  }

  function toggleLanguage(language: VoiceLanguageHint, checked: boolean): void {
    setDraft((value) => ({
      ...value,
      languageHints: checked
        ? [...value.languageHints, language]
        : value.languageHints.filter((hint) => hint !== language),
    }));
  }

  if (loading && !settings.baseUrl && !dirty) return <LoadingState title="Loading Voice settings" />;

  return (
    <form onSubmit={(event) => void save(event)} className="grid gap-5">
      <FormGroup title="Provider">
        <TextField label="Base URL" type="url" fieldWidth="full" value={draft.baseUrl} disabled={busy}
          placeholder="https://api.openai.com/v1"
          onChange={(event) => updateDraft({ baseUrl: event.currentTarget.value })} />
        <TextField label="API key" type="password" fieldWidth="full" autoComplete="new-password" value={draft.apiKey} disabled={busy}
          placeholder={settings.apiKeyConfigured ? "Saved key; leave blank to keep" : "API key"}
          onChange={(event) => updateDraft({ apiKey: event.currentTarget.value, clearApiKey: false })} />
        {settings.apiKeyConfigured ? <CheckboxField label="Remove saved key" checked={draft.clearApiKey} disabled={busy}
          onChange={(event) => updateDraft({ apiKey: "", clearApiKey: event.currentTarget.checked })} /> : null}
      </FormGroup>

      <FormGroup title="Models">
        {VOICE_CAPABILITIES.map((capability) => {
          const field = capability === "live" ? "liveModel" : capability;
          const status = settings.capabilities[capability];
          return (
            <SettingsFieldRow key={capability} title={CAPABILITY_LABELS[capability]}
              labelFor={`voice-model-${capability}`}
              content={<Input id={`voice-model-${capability}`} value={draft[field]} disabled={busy}
                onChange={(event) => updateDraft({ [field]: event.currentTarget.value })} />}
              actions={<Button loading={validating === capability} disabled={busy || dirty || !status.configured}
                title={dirty ? "Save changes to validate" : undefined}
                onClick={() => void validate(capability)}>Validate</Button>}
              feedback={!dirty ? <small role="status" className={status.error ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-gray-400"}>
                {status.validated ? "Validated" : status.error ?? (status.configured ? "Not validated" : "Not configured")}
              </small> : undefined} />
          );
        })}
      </FormGroup>

      <FormGroup title="Live Voice connection">
        <CheckboxField label="Use provider URL and key" checked={draft.liveUseVoiceProvider} disabled={busy}
          onChange={(event) => updateDraft({ liveUseVoiceProvider: event.currentTarget.checked })} />
        {!draft.liveUseVoiceProvider ? <>
          <TextField label="Live URL" type="url" fieldWidth="full" value={draft.liveBaseUrl} disabled={busy}
            onChange={(event) => updateDraft({ liveBaseUrl: event.currentTarget.value })} />
          <TextField label="Live API key" type="password" fieldWidth="full" autoComplete="new-password" value={draft.liveApiKey} disabled={busy}
            placeholder={settings.live.apiKeyConfigured ? "Saved key; leave blank to keep" : "API key"}
            onChange={(event) => updateDraft({ liveApiKey: event.currentTarget.value, clearLiveApiKey: false })} />
          {settings.live.apiKeyConfigured ? <CheckboxField label="Remove saved Live key" checked={draft.clearLiveApiKey} disabled={busy}
            onChange={(event) => updateDraft({ liveApiKey: "", clearLiveApiKey: event.currentTarget.checked })} /> : null}
        </> : null}
      </FormGroup>

      <FormGroup title="Live Voice">
        <TextAreaField label="Personal instructions" rows={6}
          value={draft.livePersonalInstructions} disabled={busy}
          maxLength={LIVE_VOICE_MAX_PERSONAL_INSTRUCTIONS_CHARS}
          hint={`${draft.livePersonalInstructions.length.toLocaleString()} / ${LIVE_VOICE_MAX_PERSONAL_INSTRUCTIONS_CHARS.toLocaleString()} characters.`}
          onChange={(event) => updateDraft({ livePersonalInstructions: event.currentTarget.value })} />
      </FormGroup>

      <FormGroup title="Languages">
        <div className="grid grid-cols-2 gap-x-5">
          {VOICE_LANGUAGE_HINTS.map((language) => <CheckboxField key={language}
            label={language === "es" ? "Spanish" : "English"} checked={draft.languageHints.includes(language)}
            disabled={busy} onChange={(event) => toggleLanguage(language, event.currentTarget.checked)} />)}
        </div>
      </FormGroup>
      <SettingsFieldRow title="Local speech" content={settings.piper.available ? "Available" : "Unavailable"} />
      {error ? <SettingsError>{error}</SettingsError> : null}
      <FormActions>
        <Button disabled={busy || !dirty} onClick={resetDraft}>Cancel</Button>
        <Button type="submit" variant="primary" loading={saving} disabled={busy || !dirty}>Save</Button>
        <span role="status" className="text-sm text-gray-500 dark:text-gray-400">{dirty ? "Unsaved changes" : error ? "" : "Saved"}</span>
      </FormActions>
    </form>
  );
}
