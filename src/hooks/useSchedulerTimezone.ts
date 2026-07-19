import { useCallback, useEffect, useRef, useState } from "react";
import { createLogger } from "@pablozaiden/webapp/web";
import { appFetch } from "../lib/public-path";

const log = createLogger("useSchedulerTimezone");
const DEFAULT_SCHEDULER_TIMEZONE = "UTC";

async function parsePreferenceError(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json() as { message?: string; error?: string };
    return data.message ?? data.error ?? fallback;
  } catch {
    return fallback;
  }
}

export interface UseSchedulerTimezoneResult {
  timezone: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  updateTimezone: (timezone: string) => Promise<string | null>;
}

export function useSchedulerTimezone(): UseSchedulerTimezoneResult {
  const [timezone, setTimezone] = useState(DEFAULT_SCHEDULER_TIMEZONE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      setLoading(true);
      setError(null);
      const response = await appFetch("/api/preferences/scheduler-timezone", { signal: controller.signal });
      if (controller.signal.aborted) {
        return;
      }
      if (!response.ok) {
        throw new Error(await parsePreferenceError(response, "Failed to load scheduler timezone"));
      }
      const data = await response.json() as { timezone?: string };
      setTimezone(data.timezone ?? DEFAULT_SCHEDULER_TIMEZONE);
    } catch (refreshError) {
      if (refreshError instanceof DOMException && refreshError.name === "AbortError") {
        return;
      }
      log.warn("Failed to load scheduler timezone", { error: String(refreshError) });
      setError(String(refreshError));
      setTimezone(DEFAULT_SCHEDULER_TIMEZONE);
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, []);

  const updateTimezone = useCallback(async (nextTimezone: string): Promise<string | null> => {
    try {
      setSaving(true);
      setError(null);
      const response = await appFetch("/api/preferences/scheduler-timezone", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: nextTimezone }),
      });
      if (!response.ok) {
        throw new Error(await parsePreferenceError(response, "Failed to save scheduler timezone"));
      }
      const data = await response.json() as { timezone?: string };
      const savedTimezone = data.timezone ?? nextTimezone;
      setTimezone(savedTimezone);
      return savedTimezone;
    } catch (saveError) {
      log.error("Failed to save scheduler timezone", { error: String(saveError) });
      setError(String(saveError));
      return null;
    } finally {
      setSaving(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => abortControllerRef.current?.abort();
  }, [refresh]);

  return {
    timezone,
    loading,
    saving,
    error,
    refresh,
    updateTimezone,
  };
}
