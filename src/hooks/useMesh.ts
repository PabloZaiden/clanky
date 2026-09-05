import { useCallback, useEffect, useRef, useState } from "react";
import type { MeshControllerStatus } from "@/shared/mesh";
import { apiRequest } from "../lib/api-client";
import { createRefreshCoordinator } from "../lib/refresh-coordinator";
import { useRealtimeRefreshWithRecovery } from "./useRealtimeStream";

interface MeshResponse {
  status?: MeshControllerStatus;
}

export interface MeshEnrollmentTokenSummary {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  controllerNodeId: string;
  controllerFingerprint: string;
}

export interface CreatedMeshEnrollment {
  token: string;
  enrollment: MeshEnrollmentTokenSummary;
}

export interface UseMeshResult {
  status: MeshControllerStatus | null;
  enrollmentTokens: MeshEnrollmentTokenSummary[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  mutationError: string | null;
  refresh: (options?: { showLoading?: boolean }) => Promise<MeshControllerStatus | null>;
  updateInstanceName: (instanceName: string) => Promise<MeshControllerStatus | null>;
  updateMeshEndpoint: (meshEndpoint: string) => Promise<MeshControllerStatus | null>;
  createEnrollmentToken: (name: string, ttlSeconds?: number) => Promise<CreatedMeshEnrollment | null>;
  revokeWorker: (workerNodeId: string) => Promise<MeshControllerStatus | null>;
  removeRevokedWorker: (workerNodeId: string) => Promise<MeshControllerStatus | null>;
  updateWorker: (workerNodeId: string) => Promise<MeshControllerStatus | null>;
  checkHealth: () => Promise<MeshControllerStatus | null>;
}

export function useMesh(): UseMeshResult {
  const [status, setStatus] = useState<MeshControllerStatus | null>(null);
  const [enrollmentTokens, setEnrollmentTokens] = useState<MeshEnrollmentTokenSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(false);
  const refreshCoordinatorRef = useRef(createRefreshCoordinator<MeshControllerStatus | null>());

  const refresh = useCallback((
    options: { showLoading?: boolean } = {},
  ): Promise<MeshControllerStatus | null> => refreshCoordinatorRef.current.run(async () => {
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    if (options.showLoading !== false && isMountedRef.current) setLoading(true);
    if (isMountedRef.current) setError(null);
    try {
      const [body, tokens] = await Promise.all([
        apiRequest<MeshControllerStatus>("/api/mesh/status", {
          signal: controller.signal,
          action: "Load Mesh status",
          fallbackMessage: "Failed to load Mesh status",
        }),
        apiRequest<MeshEnrollmentTokenSummary[]>("/api/mesh/enrollment-tokens", {
          signal: controller.signal,
          action: "Load Mesh enrollment tokens",
          fallbackMessage: "Failed to load Mesh enrollment tokens",
        }),
      ]);
      if (controller.signal.aborted || !isMountedRef.current) return null;
      const next = body;
      setStatus(next);
      setEnrollmentTokens(tokens);
      return next;
    } catch (refreshError) {
      if (controller.signal.aborted || refreshError instanceof DOMException && refreshError.name === "AbortError") {
        return null;
      }
      if (isMountedRef.current) setError(String(refreshError));
      return null;
    } finally {
      if (refreshAbortRef.current === controller) refreshAbortRef.current = null;
      if (!controller.signal.aborted && isMountedRef.current) setLoading(false);
    }
  }), []);

  useRealtimeRefreshWithRecovery({
    resources: ["mesh"],
    filters: { resource: "mesh" },
    refresh: async () => { await refresh({ showLoading: false }); },
    onReconnect: async () => { await refresh({ showLoading: false }); },
  });

  const mutate = useCallback(async (
    path: string,
    method: "POST" | "DELETE",
    body?: Record<string, unknown>,
  ): Promise<MeshControllerStatus | null> => {
    setSaving(true);
    setMutationError(null);
    try {
      const response = await apiRequest<MeshResponse>(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        action: "Update Mesh",
        fallbackMessage: "Failed to update Mesh",
      });
      if (response.status) {
        setStatus(response.status);
        return response.status;
      }
      return await refresh({ showLoading: false });
    } catch (mutationError) {
      const message = mutationError instanceof Error ? mutationError.message : String(mutationError);
      setMutationError(message);
      return null;
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  const createEnrollmentToken = useCallback(async (
    name: string,
    ttlSeconds = 900,
  ): Promise<CreatedMeshEnrollment | null> => {
    setSaving(true);
    setMutationError(null);
    try {
      const created = await apiRequest<CreatedMeshEnrollment>("/api/mesh/enrollment-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, ttlSeconds }),
        action: "Create Mesh enrollment token",
        fallbackMessage: "Failed to create Mesh enrollment token",
      });
      await refresh({ showLoading: false });
      return created;
    } catch (mutationError) {
      setMutationError(mutationError instanceof Error ? mutationError.message : String(mutationError));
      return null;
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  useEffect(() => {
    isMountedRef.current = true;
    void refresh();
    return () => {
      isMountedRef.current = false;
      refreshAbortRef.current?.abort();
      refreshCoordinatorRef.current.reset();
    };
  }, [refresh]);

  return {
    status,
    enrollmentTokens,
    loading,
    saving,
    error,
    mutationError,
    refresh,
    updateInstanceName: async (instanceName) => await mutate(
      "/api/mesh/instance-name",
      "POST",
      { instanceName },
    ),
    updateMeshEndpoint: async (meshEndpoint) => await mutate(
      "/api/mesh/endpoint",
      "POST",
      { meshEndpoint },
    ),
    createEnrollmentToken,
    revokeWorker: async (workerNodeId) => await mutate(
      "/api/mesh/workers/revoke",
      "POST",
      { workerNodeId },
    ),
    removeRevokedWorker: async (workerNodeId) => await mutate(
      `/api/mesh/workers/${encodeURIComponent(workerNodeId)}`,
      "DELETE",
    ),
    updateWorker: async (workerNodeId) => await mutate(
      `/api/mesh/workers/${encodeURIComponent(workerNodeId)}/update`,
      "POST",
    ),
    checkHealth: async () => await mutate("/api/mesh/health", "POST"),
  };
}
