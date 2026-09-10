import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionStatus } from "@/shared/settings";
import type { Workspace } from "@/shared/workspace";
import { log } from "@pablozaiden/webapp/web";
import { apiRequest } from "../../lib/api-client";

export function useWorkspaceFetch(workspaceId: string | null) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const workspaceRequest = useRef<AbortController | null>(null);
  const statusRequest = useRef<AbortController | null>(null);
  const workspaceRequestGeneration = useRef(0);
  const statusRequestGeneration = useRef(0);

  useEffect(() => {
    workspaceRequest.current?.abort();
    statusRequest.current?.abort();
    workspaceRequest.current = null;
    statusRequest.current = null;
    workspaceRequestGeneration.current += 1;
    statusRequestGeneration.current += 1;

    return () => {
      workspaceRequest.current?.abort();
      statusRequest.current?.abort();
    };
  }, [workspaceId]);

  const fetchWorkspace = useCallback(async () => {
    if (!workspaceId) {
      setWorkspace(null);
      return;
    }

    workspaceRequest.current?.abort();
    const controller = new AbortController();
    const generation = ++workspaceRequestGeneration.current;
    workspaceRequest.current = controller;
    try {
      const data = await apiRequest<Workspace>(`/api/workspaces/${workspaceId}?sensitive=true`, {
        action: "Load workspace",
        fallbackMessage: "Failed to fetch workspace",
        signal: controller.signal,
      });
      if (
        !controller.signal.aborted
        && generation === workspaceRequestGeneration.current
      ) {
        setWorkspace(data);
      }
    } catch (err) {
      if (!controller.signal.aborted && generation === workspaceRequestGeneration.current) {
        setError(String(err));
      }
    } finally {
      if (workspaceRequest.current === controller) {
        workspaceRequest.current = null;
      }
    }
  }, [workspaceId]);

  const fetchStatus = useCallback(async () => {
    if (!workspaceId) {
      setStatus(null);
      return;
    }

    statusRequest.current?.abort();
    const controller = new AbortController();
    const generation = ++statusRequestGeneration.current;
    statusRequest.current = controller;
    try {
      const data = await apiRequest<ConnectionStatus>(`/api/workspaces/${workspaceId}/server-settings/status`, {
        action: "Load workspace connection status",
        fallbackMessage: "Failed to fetch status",
        signal: controller.signal,
      });
      if (
        !controller.signal.aborted
        && generation === statusRequestGeneration.current
      ) {
        setStatus(data);
      }
    } catch (err) {
      // Don't set error for status fetch failures - non-critical
      if (!controller.signal.aborted && generation === statusRequestGeneration.current) {
        log.error("Failed to fetch connection status:", err);
      }
    } finally {
      if (statusRequest.current === controller) {
        statusRequest.current = null;
      }
    }
  }, [workspaceId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    await Promise.all([fetchWorkspace(), fetchStatus()]);
    setLoading(false);
  }, [fetchWorkspace, fetchStatus]);

  return { workspace, setWorkspace, status, setStatus, loading, setLoading, error, setError, fetchWorkspace, fetchStatus, refresh };
}
