import { useCallback, useEffect, useRef, useState } from "react";
import type { MeshStatusRecord } from "@/shared/mesh";
import { apiRequest } from "../lib/api-client";
import { createRefreshCoordinator } from "../lib/refresh-coordinator";
import { useRealtimeRefreshWithRecovery } from "./useRealtimeStream";

interface MeshResponse {
  status?: MeshStatusRecord;
}

export interface UseMeshResult {
  status: MeshStatusRecord | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  mutationError: string | null;
  refresh: (options?: { showLoading?: boolean }) => Promise<MeshStatusRecord | null>;
  updateInstanceName: (instanceName: string) => Promise<MeshStatusRecord | null>;
  updateMeshEndpoint: (meshEndpoint: string) => Promise<MeshStatusRecord | null>;
  startPairing: (targetEndpoint: string, targetLocalUserId?: string) => Promise<MeshStatusRecord | null>;
  approvePairing: (requestId: string, linkId?: string) => Promise<MeshStatusRecord | null>;
  completePairing: (requestId: string, fingerprint: string) => Promise<MeshStatusRecord | null>;
  rejectPairing: (requestId: string, reason?: string) => Promise<MeshStatusRecord | null>;
  revokeMember: (nodeId: string) => Promise<MeshStatusRecord | null>;
  removeRevokedMember: (nodeId: string) => Promise<MeshStatusRecord | null>;
  rejoin: (targetEndpoint: string, targetLocalUserId?: string) => Promise<MeshStatusRecord | null>;
}

export function useMesh(): UseMeshResult {
  const [status, setStatus] = useState<MeshStatusRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(false);
  const refreshCoordinatorRef = useRef(createRefreshCoordinator<MeshStatusRecord | null>());

  const refresh = useCallback((
    options: { showLoading?: boolean } = {},
  ): Promise<MeshStatusRecord | null> => (
    refreshCoordinatorRef.current.run(async () => {
      const controller = new AbortController();
      refreshAbortRef.current = controller;
      if (options.showLoading !== false && isMountedRef.current) {
        setLoading(true);
      }
      if (isMountedRef.current) {
        setError(null);
      }
      try {
        const body = await apiRequest<MeshResponse>("/api/mesh/status", {
          signal: controller.signal,
          action: "Load mesh status",
          fallbackMessage: "Failed to load mesh status",
        });
        if (controller.signal.aborted || !isMountedRef.current) {
          return null;
        }
        const nextStatus = (body.status ?? body) as MeshStatusRecord;
        setStatus(nextStatus);
        return nextStatus;
      } catch (refreshError) {
        if (
          controller.signal.aborted
          || refreshError instanceof DOMException && refreshError.name === "AbortError"
        ) {
          return null;
        }
        if (isMountedRef.current) {
          setError(String(refreshError));
        }
        return null;
      } finally {
        if (refreshAbortRef.current === controller) {
          refreshAbortRef.current = null;
        }
        if (!controller.signal.aborted && isMountedRef.current) {
          setLoading(false);
        }
      }
    })
  ), []);

  useRealtimeRefreshWithRecovery({
    resources: ["mesh"],
    filters: { resource: "mesh" },
    refresh: async () => {
      await refresh({ showLoading: false });
    },
    onReconnect: async () => {
      await refresh({ showLoading: false });
    },
  });

  const mutationStatus = useCallback(async (
    path: string,
    body: Record<string, unknown>,
    fallback: string,
    method: "POST" | "DELETE" = "POST",
  ): Promise<MeshStatusRecord | null> => {
    setSaving(true);
    setError(null);
    setMutationError(null);
    try {
      const response = await apiRequest<MeshResponse>(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        action: fallback,
        fallbackMessage: fallback,
      });
      if (response.status) {
        setStatus(response.status);
        return response.status;
      }
      return await refresh();
    } catch (mutationError) {
      const message = mutationError instanceof Error ? mutationError.message : String(mutationError);
      setError(message);
      setMutationError(message);
      await refresh();
      return null;
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  const startPairing = useCallback(
    (targetEndpoint: string, targetLocalUserId?: string) => mutationStatus(
      "/api/mesh/pairing-requests",
      { targetEndpoint, ...(targetLocalUserId ? { targetLocalUserId } : {}) },
      "Failed to start mesh pairing",
    ),
    [mutationStatus],
  );

  const updateInstanceName = useCallback(
    (instanceName: string) => mutationStatus(
      "/api/mesh/instance-name",
      { instanceName },
      "Failed to save mesh instance name",
    ),
    [mutationStatus],
  );

  const updateMeshEndpoint = useCallback(
    (meshEndpoint: string) => mutationStatus(
      "/api/mesh/endpoint",
      { meshEndpoint },
      "Failed to save Mesh endpoint",
    ),
    [mutationStatus],
  );

  const approvePairing = useCallback(
    (requestId: string, linkId?: string) => mutationStatus(
      `/api/mesh/pairing-requests/${encodeURIComponent(requestId)}/approve`,
      linkId ? { linkId } : {},
      "Failed to approve mesh pairing",
    ),
    [mutationStatus],
  );

  const completePairing = useCallback(
    (requestId: string, fingerprint: string) => mutationStatus(
      `/api/mesh/pairing-requests/${encodeURIComponent(requestId)}/complete`,
      { fingerprint },
      "Failed to complete mesh pairing",
    ),
    [mutationStatus],
  );

  const rejectPairing = useCallback(
    (requestId: string, reason?: string) => mutationStatus(
      `/api/mesh/pairing-requests/${encodeURIComponent(requestId)}/reject`,
      reason ? { reason } : {},
      "Failed to reject mesh pairing",
    ),
    [mutationStatus],
  );

  const revokeMember = useCallback(
    (nodeId: string) => mutationStatus(
      "/api/mesh/members/revoke",
      { nodeId },
      "Failed to revoke mesh member",
    ),
    [mutationStatus],
  );

  const removeRevokedMember = useCallback(
    (nodeId: string) => mutationStatus(
      `/api/mesh/members/${encodeURIComponent(nodeId)}`,
      {},
      "Failed to delete mesh member revocation",
      "DELETE",
    ),
    [mutationStatus],
  );

  const rejoin = useCallback(
    (targetEndpoint: string, targetLocalUserId?: string) => mutationStatus(
      "/api/mesh/rejoin",
      { targetEndpoint, ...(targetLocalUserId ? { targetLocalUserId } : {}) },
      "Failed to rejoin the mesh",
    ),
    [mutationStatus],
  );

  useEffect(() => {
    isMountedRef.current = true;
    void refresh();
    return () => {
      isMountedRef.current = false;
      refreshAbortRef.current?.abort();
      refreshAbortRef.current = null;
      refreshCoordinatorRef.current.reset();
    };
  }, [refresh]);

  return {
    status,
    loading,
    saving,
    error,
    mutationError,
    refresh,
    updateInstanceName,
    updateMeshEndpoint,
    startPairing,
    approvePairing,
    completePairing,
    rejectPairing,
    revokeMember,
    removeRevokedMember,
    rejoin,
  };
}
