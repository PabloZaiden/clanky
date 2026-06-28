/**
 * Hook for workspace live previews.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { PreviewEvent, PreviewSession } from "../types";
import { appFetch } from "../lib/public-path";
import { isPreviewEvent, useAppEvents } from "./useAppEvents";

export interface UseWorkspacePreviewsResult {
  previews: PreviewSession[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  closePreview: (previewId: string) => Promise<boolean>;
}

async function readJsonResponse<T>(response: Response, action: string): Promise<T> {
  if (!response.ok) {
    throw new Error(`${action} failed: ${response.status}`);
  }
  return await response.json() as T;
}

export function useWorkspacePreviews(workspaceId: string): UseWorkspacePreviewsResult {
  const [previews, setPreviews] = useState<PreviewSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(false);

  const refresh = useCallback(async () => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      if (isMountedRef.current) {
        setLoading(true);
        setError(null);
      }
      const response = await appFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/previews`, {
        signal: controller.signal,
      });
      const nextPreviews = await readJsonResponse<PreviewSession[]>(response, "List previews");
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
      if (!controller.signal.aborted && isMountedRef.current) {
        setLoading(false);
      }
    }
  }, [workspaceId]);

  const closePreview = useCallback(async (previewId: string): Promise<boolean> => {
    try {
      if (isMountedRef.current) {
        setError(null);
      }
      const response = await appFetch(`/api/previews/${encodeURIComponent(previewId)}`, {
        method: "DELETE",
      });
      await readJsonResponse(response, "Close preview");
      await refresh();
      return true;
    } catch (err) {
      if (isMountedRef.current) {
        setError(String(err));
      }
      return false;
    }
  }, [refresh]);

  const handleEvent = useCallback((event: PreviewEvent) => {
    if (event.workspaceId === workspaceId) {
      void refresh();
    }
  }, [refresh, workspaceId]);

  useAppEvents<PreviewEvent>(handleEvent, isPreviewEvent);

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
