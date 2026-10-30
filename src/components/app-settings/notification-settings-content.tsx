import { useState, type FormEvent } from "react";
import {
  Button, LoadingState, SettingsFieldRow, useLiveQuery, useToast, useUnsavedChanges,
} from "@pablozaiden/webapp/web";
import type { AgentNotificationSettings } from "@/contracts/schemas/agent-notifications";
import { apiRequest } from "../../lib/api-client";
import { SettingsError, SettingsInput } from "./settings-row-controls";

export function NotificationSettingsContent() {
  const { success } = useToast();
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useLiveQuery({
    load: (signal) => apiRequest<AgentNotificationSettings>("/api/preferences/notifications", { signal }),
  });
  const dirty = Boolean(url);
  function reset() {
    setUrl("");
    setError(null);
  }
  useUnsavedChanges(dirty, reset);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty) return;
    await update(url.trim());
  }

  async function update(webhookUrl: string | null) {
    if (saving || !query.data || (webhookUrl === null && !query.data.configured)) return;
    setSaving(true);
    setError(null);
    try {
      await query.mutate((signal) => apiRequest<AgentNotificationSettings>("/api/preferences/notifications", {
        signal, method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhookUrl }),
      }), (_previous, result) => result);
      reset();
      success(webhookUrl === null ? "Webhook cleared." : "Webhook saved.");
    } catch {
      setError(webhookUrl === null
        ? "Could not clear the webhook. Try again."
        : "Could not save the webhook. Check the URL and try again.");
    } finally { setSaving(false); }
  }

  if (!query.data) {
    if (query.error) return <div className="space-y-2">
      <SettingsError>Could not load notification settings.</SettingsError>
      <Button onClick={() => void query.refresh()} disabled={query.loading}>Retry</Button>
    </div>;
    return <LoadingState title="Loading notifications" />;
  }
  return <form onSubmit={(event) => void save(event)}>
    <SettingsFieldRow title="Listen webhook URL"
      labelFor="notification-webhook-url"
      content={<SettingsInput id="notification-webhook-url" type="password" autoComplete="off"
        aria-label="Listen webhook URL" placeholder={query.data.configured ? "Replace saved webhook URL" : "Listen webhook URL"}
        value={url} maxLength={4096} required disabled={saving}
        onChange={(event) => setUrl(event.currentTarget.value)} />}
      feedback={error ? <SettingsError>{error}</SettingsError> : null}
      actions={<>
        <Button type="button" disabled={!query.data.configured || saving}
          onClick={() => void update(null)}>Clear</Button>
        <Button type="button" disabled={!dirty || saving} onClick={reset}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!dirty || saving}>Save</Button>
      </>} />
  </form>;
}
