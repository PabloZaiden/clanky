import type { UseVoiceSettingsResult } from "../../hooks";
import { SettingsCheckbox } from "./settings-row-controls";

export function LiveVoiceAudioBufferRowContent({ voiceSettings }: { voiceSettings: UseVoiceSettingsResult }) {
  const { settings, loading, saving } = voiceSettings;

  async function save(enabled: boolean): Promise<void> {
    try {
      await voiceSettings.updateSettings({
        baseUrl: settings.baseUrl, models: settings.models, languageHints: settings.languageHints,
        live: {
          useVoiceProvider: settings.live.useVoiceProvider,
          baseUrl: settings.live.baseUrl, model: settings.live.model,
          jitterBufferTargetMs: enabled ? 200 : null,
        },
      });
    } catch {
      // The existing Voice settings section renders the shared save error.
    }
  }

  return (
    <SettingsCheckbox
      id="live-audio-buffer"
      ariaLabel="Use a 200 ms native Live audio buffer"
      checked={settings.live.jitterBufferTargetMs === 200}
      disabled={loading || saving}
      onChange={(event) => void save(event.currentTarget.checked)}
    />
  );
}
