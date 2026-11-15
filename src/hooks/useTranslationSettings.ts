import { useState } from "react";
import { createLogger, useLiveQuery } from "@pablozaiden/webapp/web";
import type { TranslationSettings } from "@/shared/preferences";
import { CLANKY_REALTIME_RESOURCES } from "@/shared/realtime";
import { getClankyClientCapabilities } from "../client-sdk/capabilities";
import { apiRequest } from "../lib/api-client";

const log = createLogger("useTranslationSettings");

export function useTranslationSettings() {
  const [saveStatus, setSaveStatus] = useState<"saving" | "saved" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const query = useLiveQuery({
    enabled: getClankyClientCapabilities().voice,
    load: (signal) => apiRequest<TranslationSettings>("/api/preferences/translation", {
      signal,
      action: "Load translation settings",
      fallbackMessage: "Failed to load translation settings",
    }),
    realtime: { resources: [CLANKY_REALTIME_RESOURCES.translationSettings] },
  });

  async function update(settings: TranslationSettings): Promise<void> {
    setSaveStatus("saving");
    setSaveError(null);
    try {
      await query.mutate((signal) => apiRequest<TranslationSettings>("/api/preferences/translation", {
        signal,
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
        action: "Save translation settings",
        fallbackMessage: "Failed to save translation settings",
      }), (_previous, result) => result);
      setSaveStatus("saved");
    } catch (error) {
      log.error("Failed to save translation settings", { error: String(error) });
      setSaveError(String(error));
      setSaveStatus(null);
    }
  }

  return { ...query, saveStatus, saveError, update };
}

export type UseTranslationSettingsResult = ReturnType<typeof useTranslationSettings>;
