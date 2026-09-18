/**
 * Hook for live preview sessions scoped to a workspace or execution host.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getExecutionHostSourceId,
  serializeExecutionHostRef,
  type ExecutionHostRef,
  type PreviewSession,
} from "@/shared";
import { apiRequest } from "../lib/api-client";
import { createRefreshCoordinator } from "../lib/refresh-coordinator";
import { useRealtimeRefreshWithRecovery } from "./useRealtimeStream";

export type PreviewSessionScope =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "server"; executionHost: ExecutionHostRef };

export interface UsePreviewSessionsResult {
  previews: PreviewSession[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  closePreview: (previewId: string) => Promise<boolean>;
}

function getScopeKey(scope: PreviewSessionScope): string {
  return scope.kind === "workspace"
    ? `workspace:${scope.workspaceId}`
    : serializeExecutionHostRef(scope.executionHost);
}

function getListUrl(scope: PreviewSessionScope): string {
  if (scope.kind === "workspace") {
    return `/api/workspaces/${encodeURIComponent(scope.workspaceId)}/previews`;
  }
  return `/api/execution-hosts/${encodeURIComponent(scope.executionHost.kind)}/${encodeURIComponent(
    getExecutionHostSourceId(scope.executionHost),
  )}/previews`;
}

export function usePreviewSessions(scope: PreviewSessionScope): UsePreviewSessionsResult {
  const scopeKey = getScopeKey(scope);
  const listUrl = getListUrl(scope);
  const [previews, setPreviews] = useState<PreviewSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(false);
  const refreshCoordinatorRef = useRef(createRefreshCoordinator<void>());

  const refresh = useCallback((options: { showLoading?: boolean } = {}) => (
    refreshCoordinatorRef.current.run(async () => {
      const showLoading = options.showLoading ?? true;
      const controller = new AbortController();
      abortControllerRef.current = controller;
      try {
        if (showLoading && isMountedRef.current) {
          setLoading(true);
          setError(null);
        }
        const nextPreviews = await apiRequest<PreviewSession[]>(
          listUrl,
          {
            signal: controller.signal,
            action: "List previews",
            fallbackMessage: "Failed to list previews",
          },
        );
        if (controller.signal.aborted || !isMountedRef.current) {
          return;
        }
        setPreviews(nextPreviews);
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        if (isMountedRef.current) {
          setError(String(err));
        }
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        if (showLoading && !controller.signal.aborted && isMountedRef.current) {
          setLoading(false);
        }
      }
    })
  ), [listUrl]);

  const closePreview = useCallback(async (previewId: string): Promise<boolean> => {
    try {
      if (isMountedRef.current) {
        setError(null);
      }
      await apiRequest(`/api/previews/${encodeURIComponent(previewId)}`, {
        method: "DELETE",
        action: "Close preview",
        fallbackMessage: "Failed to close preview",
      });
      await refresh();
      return true;
    } catch (err) {
      if (isMountedRef.current) {
        setError(String(err));
      }
      return false;
    }
  }, [refresh]);

  useRealtimeRefreshWithRecovery({
    resources: ["previews"],
    filters: { resource: "previews", scope: scopeKey.startsWith("workspace:")
      ? scopeKey.slice("workspace:".length)
      : scopeKey },
    refresh: (event) => {
      if (event.action === "deleted") {
        setPreviews((current) => current.filter((preview) => preview.config.id !== event.id));
        return;
      }
      return refresh({ showLoading: false });
    },
    onReconnect: () => refresh({ showLoading: false }),
  });

  useEffect(() => {
    isMountedRef.current = true;
    void refresh();
    return () => {
      isMountedRef.current = false;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      refreshCoordinatorRef.current.reset();
    };
  }, [refresh]);

  return { previews, loading, error, refresh, closePreview };
}
