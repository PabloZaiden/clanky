import { useState, type FormEvent } from "react";
import {
  Button, createLogger, LoadingState, SettingsFieldRow, useLiveQuery, useToast, useUnsavedChanges,
} from "@pablozaiden/webapp/web";
import type { AgentNotificationSettings, SetAgentNotificationSettings } from "@/contracts/schemas/agent-notifications";
import { NOTIFICATION_EVENT_LABELS, type NotificationEventKind } from "@/shared/agent-notifications";
import { CLANKY_REALTIME_RESOURCES } from "@/shared/realtime";
import { apiRequest } from "../../lib/api-client";
import { SettingsCheckbox, SettingsError, SettingsInput } from "./settings-row-controls";

const log = createLogger("notification-settings");

export function NotificationSettingsContent() {
  const { success } = useToast();
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState<"webhook" | "enabled" | NotificationEventKind | null>(null);
  const [preferenceError, setPreferenceError] = useState<{ key: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = useLiveQuery({
    load: (signal) => apiRequest<AgentNotificationSettings>("/api/preferences/notifications", { signal }),
    realtime: { resources: [CLANKY_REALTIME_RESOURCES.notificationSettings] },
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
    setSaving("webhook");
    setError(null);
    try {
      await query.mutate((signal) => apiRequest<AgentNotificationSettings>("/api/preferences/notifications", {
        signal, method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhookUrl }),
      }), (_previous, result) => result);
      reset();
      success(webhookUrl === null ? "Webhook cleared." : "Webhook saved.");
    } catch {
      log.error("Could not update the notification webhook.");
      setError(webhookUrl === null
        ? "Could not clear the webhook. Try again."
        : "Could not save the webhook. Check the URL and try again.");
    } finally { setSaving(null); }
  }

  async function updatePreference(key: "enabled" | NotificationEventKind, checked: boolean) {
    if (saving || !query.data) return;
    setSaving(key);
    setPreferenceError(null);
    const input: SetAgentNotificationSettings = key === "enabled"
      ? { enabled: checked } : { events: { [key]: checked } };
    try {
      await query.mutate((signal) => apiRequest<AgentNotificationSettings>("/api/preferences/notifications", {
        signal, method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }), (_previous, result) => result);
    } catch {
      log.error("Could not save notification preference.", { key });
      setPreferenceError({ key, message: "Could not save this preference. Try again." });
    } finally { setSaving(null); }
  }

  function preferenceRow(key: "enabled" | NotificationEventKind, title: string, checked: boolean) {
    const id = `notification-${key}`;
    return <SettingsFieldRow key={key} title={title} labelFor={id}
      content={<SettingsCheckbox id={id} ariaLabel={title} checked={checked} disabled={saving !== null}
        onChange={(event) => void updatePreference(key, event.currentTarget.checked)} />}
      feedback={preferenceError?.key === key ? <SettingsError>{preferenceError.message}</SettingsError>
        : saving === key ? <span role="status">Saving...</span> : null} />;
  }

  if (!query.data) {
    if (query.error) return <div className="space-y-2">
      <SettingsError>Could not load notification settings.</SettingsError>
      <Button onClick={() => void query.refresh()} disabled={query.loading}>Retry</Button>
    </div>;
    return <LoadingState title="Loading notifications" />;
  }
  return <>
    {query.error && !preferenceError && !error
      ? <SettingsError>Could not refresh notification settings.</SettingsError> : null}
    {preferenceRow("enabled", "Receive automatic notifications", query.data.enabled)}
    <div role="group" aria-label="Automatic notification events" className="pl-3">
      {(Object.keys(NOTIFICATION_EVENT_LABELS) as NotificationEventKind[]).map((key) =>
        preferenceRow(key, NOTIFICATION_EVENT_LABELS[key], query.data!.events[key]))}
    </div>
    {query.data.lastDeliveryError ? <SettingsError>
      Last automatic notification failure ({new Date(query.data.lastDeliveryError.timestamp).toLocaleString()}):{" "}
      {query.data.lastDeliveryError.message}
    </SettingsError> : null}
    <form onSubmit={(event) => void save(event)}>
    <SettingsFieldRow title="Listen webhook URL"
      labelFor="notification-webhook-url"
      content={<SettingsInput id="notification-webhook-url" type="password" autoComplete="off"
        aria-label="Listen webhook URL" placeholder={query.data.configured ? "Replace saved webhook URL" : "Listen webhook URL"}
        value={url} maxLength={4096} required disabled={saving !== null}
        onChange={(event) => setUrl(event.currentTarget.value)} />}
      feedback={error ? <SettingsError>{error}</SettingsError> : null}
      actions={<>
        <Button type="button" disabled={!query.data.configured || saving !== null}
          onClick={() => void update(null)}>Clear</Button>
        <Button type="button" disabled={!dirty || saving !== null} onClick={reset}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!dirty || saving !== null}>Save</Button>
      </>} />
    </form>
  </>;
}
