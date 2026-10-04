import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@pablozaiden/webapp/web";
import type { HarnessActivitySnapshot, HarnessActivityStopResult } from "@/shared/harness-control";
import { apiRequest } from "../lib/api-client";

export function useHarnessActivity({
  kind,
  entityId,
  snapshot,
}: {
  kind: "chat" | "task";
  entityId: string;
  snapshot?: HarnessActivitySnapshot;
}) {
  const toast = useToast();
  const [activity, setActivity] = useState(snapshot);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [stoppingId, setStoppingId] = useState<string>();
  const [unconfirmedId, setUnconfirmedId] = useState<string>();
  const readRef = useRef<AbortController | null>(null);
  const stoppingRef = useRef(false);
  const mountedRef = useRef(true);
  const path = `/api/${kind}s/${encodeURIComponent(entityId)}/activity`;
  const refresh = useCallback(async (): Promise<void> => {
    if (!mountedRef.current) return;
    readRef.current?.abort();
    const controller = new AbortController();
    readRef.current = controller;
    try {
      const result = await apiRequest<{ activity: HarnessActivitySnapshot }>(path, {
        signal: controller.signal,
        action: "Observe harness activity",
      });
      if (!controller.signal.aborted) {
        setActivity(result.activity);
        setError(undefined);
      }
    } catch (readError) {
      if (!controller.signal.aborted) setError(String(readError));
    } finally {
      if (!controller.signal.aborted) setLoaded(true);
    }
  }, [path]);
  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
      readRef.current?.abort();
    };
  }, [refresh]);
  // The entity lifecycle already refreshes this projection through private resource events.
  useEffect(() => { if (snapshot) setActivity(snapshot); }, [snapshot]);
  useEffect(() => {
    if (activity?.observation === "available" && activity.activities.some((item) =>
      item.id === unconfirmedId && (item.status === "stopped" || item.status === "completed"))) {
      setUnconfirmedId(undefined);
    }
  }, [activity, unconfirmedId]);

  async function stop(activityId: string): Promise<void> {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    setStoppingId(activityId);
    try {
      const { result } = await apiRequest<{ result: HarnessActivityStopResult }>(
        `${path}/${encodeURIComponent(activityId)}/stop`,
        { method: "POST", action: "Stop owned activity" },
      );
      if (mountedRef.current) setUnconfirmedId(result.status === "unknown" ? activityId : undefined);
      if (result.status === "stopped") toast.success("Activity stopped.");
      if (result.status === "stopping") toast.info("Stop requested; waiting for termination.");
      await refresh();
    } catch (stopError) {
      toast.error(String(stopError));
    } finally {
      stoppingRef.current = false;
      if (mountedRef.current) setStoppingId(undefined);
    }
  }
  return { activity, loaded, error, stoppingId, unconfirmedId, refresh, stop };
}
