import { useState } from "react";
import { useLiveQuery } from "@pablozaiden/webapp/web";
import type { AgentNotificationSettings, SetAgentNotificationSettings } from "@/contracts/schemas/agent-notifications";
import type { NotificationEventKind } from "@/shared/agent-notifications";
import { CLANKY_REALTIME_RESOURCES } from "@/shared/realtime";
import { apiRequest } from "../lib/api-client";

type NotificationSettingKey = "webhook" | "enabled" | NotificationEventKind;

export function useNotificationSettings(enabled: boolean) {
  const [saving, setSaving] = useState<NotificationSettingKey | null>(null);
  const query = useLiveQuery({
    enabled,
    load: (signal) => apiRequest<AgentNotificationSettings>("/api/preferences/notifications", { signal }),
    realtime: { resources: [CLANKY_REALTIME_RESOURCES.notificationSettings] },
  });

  async function update(key: NotificationSettingKey, input: SetAgentNotificationSettings) {
    setSaving(key);
    try {
      return await query.mutate((signal) => apiRequest<AgentNotificationSettings>("/api/preferences/notifications", {
        signal, method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }), (_previous, result) => result);
    } finally {
      setSaving(null);
    }
  }

  return { ...query, saving, update };
}

export type NotificationSettings = ReturnType<typeof useNotificationSettings>;
