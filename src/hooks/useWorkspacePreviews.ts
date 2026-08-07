/**
 * Hook for workspace live previews.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { PreviewSession } from "@/shared";
import { apiRequest } from "../lib/api-client";
import { useRealtimeRefreshWithRecovery } from "./useRealtimeStream";

export interface UseWorkspacePreviewsResult {
  previews: PreviewSession[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  closePreview: (previewId: string) => Promise<boolean>;
}

export function useWorkspacePreviews(workspaceId: string): UseWorkspacePreviewsResult {
  const [previews, setPreviews] = useState<PreviewSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(false);

  const refresh = useCallback(async (options: { showLoading?: boolean } = {}) => {
    const showLoading = options.showLoading ?? true;
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      if (showLoading && isMountedRef.current) {
        setLoading(true);
        setError(null);
      }
      const nextPreviews = await apiRequest<PreviewSession[]>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/previews`,
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
      if (err instanceof DOMException && err.name === "AbortError") {
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
  }, [workspaceId]);

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
    filters: { resource: "previews", scope: workspaceId },
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
    };
  }, [refresh]);

  return { previews, loading, error, refresh, closePreview };
}
