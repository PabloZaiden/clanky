import { useState, type FormEvent } from "react";
import {
  Button, createLogger, FormActions, LoadingState, SettingsFieldRow, TextAreaField, useToast, useUnsavedChanges,
} from "@pablozaiden/webapp/web";
import {
  NotificationPayloadSchema, NotificationWebhookUrlSchema,
  type NotificationPayload, type SetAgentNotificationSettings,
} from "@/contracts/schemas/agent-notifications";
import {
  DEFAULT_NOTIFICATION_TEMPLATE, notificationTemplateError, NOTIFICATION_TEMPLATE_MAX_BYTES,
  NOTIFICATION_EVENT_LABELS, type NotificationEventKind,
} from "@/shared/agent-notifications";
import type { NotificationSettings } from "../../hooks/useNotificationSettings";
import { SettingsCheckbox, SettingsError, SettingsInput, SettingsSelect } from "./settings-row-controls";

const log = createLogger("notification-settings");

export function NotificationSettingsContent({ settings: query }: { settings: NotificationSettings }) {
  const { success } = useToast();
  const [url, setUrl] = useState("");
  const [payloadMode, setPayloadMode] = useState<NotificationPayload["mode"] | null>(null);
  const [templateDraft, setTemplateDraft] = useState<string | null>(null);
  const { saving } = query;
  const [preferenceError, setPreferenceError] = useState<{ key: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const savedPayload = query.data?.payload;
  const mode = payloadMode ?? savedPayload?.mode ?? "listen";
  const template = templateDraft ?? (savedPayload?.mode === "custom" ? savedPayload.template : DEFAULT_NOTIFICATION_TEMPLATE);
  const payload: NotificationPayload = mode === "listen" ? { mode } : { mode, template };
  const payloadDirty = Boolean(savedPayload && (mode !== savedPayload.mode
    || (mode === "custom" && savedPayload.mode === "custom" && template !== savedPayload.template)));
  const dirty = Boolean(url) || payloadDirty;
  const templateError = mode === "custom" ? notificationTemplateError(template) : null;
  function reset() {
    setUrl("");
    setPayloadMode(null);
    setTemplateDraft(null);
    setError(null);
  }
  useUnsavedChanges(dirty, reset);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || saving || !query.data) return;
    setError(null);
    const input: SetAgentNotificationSettings = {};
    if (url) {
      const parsedUrl = NotificationWebhookUrlSchema.safeParse(url);
      if (!parsedUrl.success) {
        setError(parsedUrl.error.issues[0]!.message);
        return;
      }
      input.webhookUrl = parsedUrl.data;
    }
    if (payloadDirty) {
      const parsedPayload = NotificationPayloadSchema.safeParse(payload);
      if (!parsedPayload.success) {
        setError(parsedPayload.error.issues[0]!.message);
        return;
      }
      input.payload = parsedPayload.data;
    }
    try {
      await query.update("webhook", input);
      reset();
      success("Webhook settings saved.");
    } catch {
      log.error("Could not save notification webhook settings.");
      setError("Could not save webhook settings. Try again.");
    }
  }

  async function clearWebhook() {
    if (saving || !query.data?.configured) return;
    setError(null);
    try {
      await query.update("webhook", { webhookUrl: null });
      setUrl("");
      success("Webhook cleared.");
    } catch {
      log.error("Could not clear the notification webhook.");
      setError("Could not clear the webhook. Try again.");
    }
  }

  async function updatePreference(key: "enabled" | NotificationEventKind, checked: boolean) {
    if (saving || !query.data) return;
    setPreferenceError(null);
    const input: SetAgentNotificationSettings = key === "enabled"
      ? { enabled: checked } : { events: { [key]: checked } };
    try {
      await query.update(key, input);
    } catch {
      log.error("Could not save notification preference.", { key });
      setPreferenceError({ key, message: "Could not save this preference. Try again." });
    }
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
    <SettingsFieldRow title={mode === "listen" ? "Listen webhook URL" : "Webhook URL"}
      labelFor="notification-webhook-url"
      content={<SettingsInput id="notification-webhook-url" type="password" autoComplete="off"
        aria-label="Webhook URL" placeholder={query.data.configured ? "Replace saved webhook URL" : "Webhook URL"}
        value={url} maxLength={4096} disabled={saving !== null}
        onChange={(event) => setUrl(event.currentTarget.value)} />}
      actions={<Button type="button" disabled={!query.data.configured || saving !== null}
        onClick={() => void clearWebhook()}>Clear</Button>} />
    <SettingsFieldRow title="Payload" labelFor="notification-payload-mode"
      content={<SettingsSelect id="notification-payload-mode" aria-label="Webhook payload" value={mode}
        disabled={saving !== null} onChange={(event) => {
          setPayloadMode(event.currentTarget.value === "custom" ? "custom" : "listen");
          setError(null);
        }}>
        <option value="listen">Listen</option>
        <option value="custom">Custom JSON</option>
      </SettingsSelect>} />
    {mode === "custom" ? <SettingsFieldRow title="JSON template" labelFor="notification-payload-template"
      content={<TextAreaField id="notification-payload-template" label="" aria-label="Custom JSON payload template"
        className="font-mono" rows={7} value={template} maxLength={NOTIFICATION_TEMPLATE_MAX_BYTES}
        disabled={saving !== null} spellCheck={false}
        hint="Use {{title}}, {{shortDescription}}, and {{markdownContent}} in JSON string values. Maximum 64 KiB."
        error={templateError ?? undefined}
        onChange={(event) => {
          setTemplateDraft(event.currentTarget.value);
          setError(null);
        }} />} /> : null}
    {error ? <SettingsError>{error}</SettingsError> : null}
    <FormActions>
      <Button type="button" disabled={!dirty || saving !== null} onClick={reset}>Cancel</Button>
      <Button type="submit" variant="primary" disabled={!dirty || saving !== null || Boolean(templateError)}>Save</Button>
    </FormActions>
    </form>
  </>;
}
