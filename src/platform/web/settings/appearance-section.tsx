import { useId, useState } from "react";
import { useAsyncOperation } from "@pablozaiden/webapp/web";
import { Button, ErrorState, FormSection, Select } from "@pablozaiden/webapp/web";
import { isThemePreference, useTheme } from "@pablozaiden/webapp/web";
import { SettingsFieldRow } from "@pablozaiden/webapp/web";

export function AppearanceSection({ setError }: { setError: (error: string | undefined) => void }) {
  const themeId = useId();
  const { preference, savePreference, loading, error, retry } = useTheme();
  const { pending: saving, start, finish, isCurrent } = useAsyncOperation({ abortOnUnmount: false });
  const [saved, setSaved] = useState(false);

  async function updateTheme(value: string) {
    if (!isThemePreference(value)) {
      setError("Invalid theme");
      return;
    }
    const token = start();
    if (!token) return;
    setSaved(false);
    setError(undefined);
    try {
      await savePreference(value);
      if (isCurrent(token)) setSaved(true);
    } catch (error) {
      if (isCurrent(token)) setError(error instanceof Error ? error.message : String(error));
    } finally {
      finish(token);
    }
  }

  return <FormSection title="Appearance">
    <SettingsFieldRow
      title="Theme"
      labelFor={themeId}
      content={<Select id={themeId} value={preference} disabled={loading || saving} onChange={(event) => void updateTheme(event.currentTarget.value)}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </Select>}
      feedback={loading || saving || saved ? <small role="status" className="wapp-save-status">{loading ? "Loading…" : saving ? "Saving…" : "Saved"}</small> : undefined}
    />
    {error ? <ErrorState description={error.message} action={<Button type="button" loading={loading} onClick={() => void retry()}>Retry</Button>} /> : null}
  </FormSection>;
}
