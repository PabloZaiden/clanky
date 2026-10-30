import { useState, type FormEvent } from "react";
import {
  Button, CheckboxField, FormActions, LoadingState, useLiveQuery, useUnsavedChanges,
} from "@pablozaiden/webapp/web";
import type { AgentNotificationSettings } from "@/contracts/schemas/agent-notifications";
import { apiRequest } from "../../lib/api-client";
import { SettingsError, SettingsInput } from "./settings-row-controls";

export function NotificationSettingsContent() {
  const [url, setUrl] = useState("");
  const [clear, setClear] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useLiveQuery({
    load: (signal) => apiRequest<AgentNotificationSettings>("/api/preferences/notifications", { signal }),
  });
  const dirty = Boolean(url || clear);
  function reset() {
    setUrl("");
    setClear(false);
    setError(null);
  }
  useUnsavedChanges(dirty, reset);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !query.data || !dirty) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await query.mutate((signal) => apiRequest<AgentNotificationSettings>("/api/preferences/notifications", {
        signal, method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhookUrl: clear ? null : url.trim() }),
      }), (_previous, result) => result);
      reset();
      setSaved(true);
    } catch {
      setError("Could not save the webhook. Check the URL and try again.");
    } finally { setSaving(false); }
  }

  if (!query.data) {
    if (query.error) return <div className="space-y-2">
      <SettingsError>Could not load notification settings.</SettingsError>
      <Button onClick={() => void query.refresh()} disabled={query.loading}>Retry</Button>
    </div>;
    return <LoadingState title="Loading notifications" />;
  }
  return <form className="w-full space-y-2" onSubmit={(event) => void save(event)}>
    <SettingsInput id="notification-webhook-url" type="password" autoComplete="off"
      aria-label="Listen webhook URL" placeholder={query.data.configured ? "Replace saved webhook URL" : "Listen webhook URL"}
      value={url} maxLength={4096} required={!clear} disabled={saving || clear}
      onChange={(event) => { setUrl(event.currentTarget.value); setSaved(false); }} />
    <span className="text-sm" role="status">
      {saving ? "Saving..." : saved ? "Saved." : query.data.configured ? "Webhook configured." : "No webhook configured."}
    </span>
    {query.data.configured ? <CheckboxField label="Clear saved webhook" checked={clear} disabled={saving}
      onChange={(event) => { setClear(event.currentTarget.checked); setSaved(false); }} /> : null}
    {error ? <SettingsError>{error}</SettingsError> : null}
    <FormActions>
      <Button type="button" disabled={!dirty || saving} onClick={reset}>Cancel</Button>
      <Button type="submit" variant="primary" disabled={!dirty || saving}>Save</Button>
    </FormActions>
  </form>;
}
