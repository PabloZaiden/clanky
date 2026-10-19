/**
 * Hook for live preview sessions scoped to a workspace or execution host.
 */

import { useCallback, useState } from "react";
import {
  getExecutionHostSourceId,
  serializeExecutionHostRef,
  type ExecutionHostRef,
  type PreviewSession,
} from "@/shared";
import { apiRequest } from "../lib/api-client";
import { useLiveQuery, useRealtime } from "@pablozaiden/webapp/web";

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
  const [mutationError, setMutationError] = useState<{ scopeKey: string; message: string } | null>(null);
  const query = useLiveQuery<PreviewSession[]>({
    load: (signal) => apiRequest<PreviewSession[]>(listUrl, {
      signal,
      action: "List previews",
      fallbackMessage: "Failed to list previews",
    }),
    deps: [scopeKey],
    realtime: {
      resources: ["previews"],
      scopes: [scope.kind === "workspace" ? scope.workspaceId : scopeKey],
    },
  });
  const mutate = query.mutate;
  const refresh = useCallback(async () => {
    setMutationError(null);
    await query.refresh();
  }, [query.refresh]);
  useRealtime({
    resources: ["execution-hosts"],
    enabled: scope.kind === "server",
    trackLastEvent: false,
    onEvent: () => { void query.refresh(); },
  });

  const closePreview = useCallback(async (previewId: string): Promise<boolean> => {
    try {
      setMutationError(null);
      await mutate((signal) => apiRequest(`/api/previews/${encodeURIComponent(previewId)}`, {
        signal,
        method: "DELETE",
        action: "Close preview",
        fallbackMessage: "Failed to close preview",
      }), (previous) => previous?.filter((preview) => preview.config.id !== previewId));
      return true;
    } catch (err) {
      setMutationError({ scopeKey, message: String(err) });
      return false;
    }
  }, [mutate, scopeKey]);

  return {
    previews: query.data ?? [],
    loading: query.data === undefined && query.loading,
    error: mutationError?.scopeKey === scopeKey ? mutationError.message : query.error ? String(query.error) : null,
    refresh,
    closePreview,
  };
}
