import { useCallback, useEffect, useRef, useState } from "react";
import { createLogger } from "@pablozaiden/webapp/web";
import { apiRequest } from "../lib/api-client";

const log = createLogger("useSchedulerTimezone");
const DEFAULT_SCHEDULER_TIMEZONE = "UTC";

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
      const data = await apiRequest<{ timezone?: string }>("/api/preferences/scheduler-timezone", {
        signal: controller.signal,
        action: "Load scheduler timezone",
        fallbackMessage: "Failed to load scheduler timezone",
      });
      if (controller.signal.aborted) {
        return;
      }
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
      const data = await apiRequest<{ timezone?: string }>("/api/preferences/scheduler-timezone", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: nextTimezone }),
        action: "Save scheduler timezone",
        fallbackMessage: "Failed to save scheduler timezone",
      });
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
