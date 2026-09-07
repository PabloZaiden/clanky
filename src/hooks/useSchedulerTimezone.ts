import { useCallback, useEffect, useRef, useState } from "react";
import { createLogger } from "@pablozaiden/webapp/web";
import { apiRequest } from "../lib/api-client";
import { createRefreshCoordinator } from "../lib/refresh-coordinator";

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
  const isMountedRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const refreshCoordinatorRef = useRef(createRefreshCoordinator<void>());

  const refresh = useCallback(() => {
    return refreshCoordinatorRef.current.run(async () => {
      if (!isMountedRef.current) {
        return;
      }

      const requestId = ++requestIdRef.current;
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const isActiveRequest = () =>
        isMountedRef.current
        && abortControllerRef.current === controller
        && requestIdRef.current === requestId;

      try {
        setLoading(true);
        setError(null);
        const data = await apiRequest<{ timezone?: string }>("/api/preferences/scheduler-timezone", {
          signal: controller.signal,
          action: "Load scheduler timezone",
          fallbackMessage: "Failed to load scheduler timezone",
        });
        if (controller.signal.aborted || !isActiveRequest()) {
          return;
        }
        setTimezone(data.timezone ?? DEFAULT_SCHEDULER_TIMEZONE);
      } catch (refreshError) {
        if (controller.signal.aborted || !isActiveRequest()) {
          return;
        }
        log.warn("Failed to load scheduler timezone", { error: String(refreshError) });
        setError(String(refreshError));
        setTimezone(DEFAULT_SCHEDULER_TIMEZONE);
      } finally {
        if (isActiveRequest()) {
          abortControllerRef.current = null;
          setLoading(false);
        }
      }
    });
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
    isMountedRef.current = true;
    void refresh();
    return () => {
      isMountedRef.current = false;
      requestIdRef.current += 1;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      refreshCoordinatorRef.current.reset();
    };
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
