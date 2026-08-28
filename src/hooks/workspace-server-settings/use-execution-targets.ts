import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceExecutionTarget } from "@/shared/workspace";
import { apiRequest } from "../../lib/api-client";
import { createLogger } from "@pablozaiden/webapp/web";
import { isAbortError } from "../../lib/request-lifecycle";

const log = createLogger("useWorkspaceExecutionTargets");

export function useWorkspaceExecutionTargets(): {
  targets: WorkspaceExecutionTarget[];
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [targets, setTargets] = useState<WorkspaceExecutionTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const activeControllerRef = useRef<AbortController | null>(null);
  const latestRequestIdRef = useRef(0);
  const mountedRef = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (!mountedRef.current) {
      return;
    }
    activeControllerRef.current?.abort();
    const requestId = latestRequestIdRef.current + 1;
    latestRequestIdRef.current = requestId;
    const controller = new AbortController();
    activeControllerRef.current = controller;
    const isActiveRequest = () =>
      mountedRef.current
      && activeControllerRef.current === controller
      && latestRequestIdRef.current === requestId
      && !controller.signal.aborted;

    setLoading(true);
    try {
      const nextTargets = await apiRequest<WorkspaceExecutionTarget[]>("/api/workspaces/execution-targets", {
        action: "Load workspace execution targets",
        fallbackMessage: "Failed to load workspace execution targets",
        signal: controller.signal,
      });
      if (!isActiveRequest()) {
        return;
      }
      setTargets(nextTargets);
    } catch (error) {
      if (!isActiveRequest() || isAbortError(error)) {
        return;
      }
      log.warn("Failed to load workspace execution targets", { error: String(error) });
      setTargets([]);
    } finally {
      if (isActiveRequest()) {
        activeControllerRef.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
      latestRequestIdRef.current += 1;
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
    };
  }, [refresh]);

  return { targets, loading, refresh };
}
