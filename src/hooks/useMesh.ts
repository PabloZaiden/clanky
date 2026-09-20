import { useCallback, useEffect, useRef, useState } from "react";
import type { MeshControllerStatus } from "@/shared/mesh";
import type { MeshEnrollmentRoute } from "@/contracts/schemas/mesh";
import type { ControllerRelayPairingStatus } from "@/contracts/relay";
import { apiRequest } from "../lib/api-client";
import { createRefreshCoordinator } from "../lib/refresh-coordinator";
import { useRealtimeRefreshWithRecovery } from "./useRealtimeStream";

interface MeshResponse {
  status?: MeshControllerStatus;
}

interface MeshMutationResult {
  succeeded: boolean;
  status: MeshControllerStatus | null;
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
  workerJoinCommand: string;
}

export interface UseMeshResult {
  status: MeshControllerStatus | null;
  relayStatus: ControllerRelayPairingStatus | null;
  relayStatusLoading: boolean;
  enrollmentTokens: MeshEnrollmentTokenSummary[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  mutationError: string | null;
  refresh: (options?: { showLoading?: boolean }) => Promise<MeshControllerStatus | null>;
  refreshRelayStatus: () => Promise<ControllerRelayPairingStatus | null>;
  updateInstanceName: (instanceName: string) => Promise<MeshControllerStatus | null>;
  updateMeshEndpoint: (meshEndpoint: string) => Promise<MeshControllerStatus | null>;
  createEnrollmentToken: (
    name: string,
    ttlSeconds?: number,
    route?: MeshEnrollmentRoute,
  ) => Promise<CreatedMeshEnrollment | null>;
  revokeWorker: (workerNodeId: string) => Promise<boolean>;
  killWorker: (workerNodeId: string) => Promise<MeshControllerStatus | null>;
  removeRevokedWorker: (workerNodeId: string) => Promise<MeshControllerStatus | null>;
  checkHealth: () => Promise<MeshControllerStatus | null>;
}

export function useMesh(): UseMeshResult {
  const [status, setStatus] = useState<MeshControllerStatus | null>(null);
  const [relayStatus, setRelayStatus] = useState<ControllerRelayPairingStatus | null>(null);
  const [relayStatusLoading, setRelayStatusLoading] = useState(true);
  const [enrollmentTokens, setEnrollmentTokens] = useState<MeshEnrollmentTokenSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const relayRefreshAbortRef = useRef<AbortController | null>(null);
  const relayStatusRequestIdRef = useRef(0);
  const isMountedRef = useRef(false);
  const refreshCoordinatorRef = useRef(createRefreshCoordinator<MeshControllerStatus | null>());

  const refresh = useCallback((
    options: { showLoading?: boolean } = {},
  ): Promise<MeshControllerStatus | null> => refreshCoordinatorRef.current.run(async () => {
    const controller = new AbortController();
    const relayStatusRequestId = ++relayStatusRequestIdRef.current;
    refreshAbortRef.current = controller;
    if (options.showLoading !== false && isMountedRef.current) setLoading(true);
    if (isMountedRef.current) setRelayStatusLoading(true);
    if (isMountedRef.current) setError(null);
    try {
      const [body, tokens, relay] = await Promise.all([
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
        apiRequest<ControllerRelayPairingStatus>("/api/mesh/relay", {
          signal: controller.signal,
          action: "Load Mesh relay status",
          fallbackMessage: "Failed to load Mesh relay status",
        }),
      ]);
      if (controller.signal.aborted || !isMountedRef.current) return null;
      const next = body;
      setStatus(next);
      if (relayStatusRequestId === relayStatusRequestIdRef.current) {
        setRelayStatus(relay);
      }
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
      if (
        relayStatusRequestId === relayStatusRequestIdRef.current
        && !controller.signal.aborted
        && isMountedRef.current
      ) {
        setRelayStatusLoading(false);
      }
      if (!controller.signal.aborted && isMountedRef.current) setLoading(false);
    }
  }), []);

  const refreshRelayStatus = useCallback(async (): Promise<ControllerRelayPairingStatus | null> => {
    relayRefreshAbortRef.current?.abort();
    const controller = new AbortController();
    const relayStatusRequestId = ++relayStatusRequestIdRef.current;
    relayRefreshAbortRef.current = controller;
    if (isMountedRef.current) setRelayStatusLoading(true);
    try {
      const next = await apiRequest<ControllerRelayPairingStatus>("/api/mesh/relay", {
        signal: controller.signal,
        action: "Load Mesh relay status",
        fallbackMessage: "Failed to load Mesh relay status",
      });
      if (controller.signal.aborted || !isMountedRef.current) {
        return null;
      }
      if (relayStatusRequestId === relayStatusRequestIdRef.current) {
        setRelayStatus(next);
      }
      return next;
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
      if (relayRefreshAbortRef.current === controller) {
        relayRefreshAbortRef.current = null;
      }
      if (
        relayStatusRequestId === relayStatusRequestIdRef.current
        && !controller.signal.aborted
        && isMountedRef.current
      ) {
        setRelayStatusLoading(false);
      }
    }
  }, []);

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
  ): Promise<MeshMutationResult> => {
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
        return { succeeded: true, status: response.status };
      }
      return {
        succeeded: true,
        status: await refresh({ showLoading: false }),
      };
    } catch (mutationError) {
      const message = mutationError instanceof Error ? mutationError.message : String(mutationError);
      setMutationError(message);
      return { succeeded: false, status: null };
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  const createEnrollmentToken = useCallback(async (
    name: string,
    ttlSeconds = 900,
    route: MeshEnrollmentRoute = "direct",
  ): Promise<CreatedMeshEnrollment | null> => {
    setSaving(true);
    setMutationError(null);
    try {
      const created = await apiRequest<CreatedMeshEnrollment>("/api/mesh/enrollment-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, ttlSeconds, route }),
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
      relayRefreshAbortRef.current?.abort();
      relayStatusRequestIdRef.current += 1;
      refreshCoordinatorRef.current.reset();
    };
  }, [refresh]);

  return {
    status,
    relayStatus,
    relayStatusLoading,
    enrollmentTokens,
    loading,
    saving,
    error,
    mutationError,
    refresh,
    refreshRelayStatus,
    updateInstanceName: async (instanceName) => (
      await mutate("/api/mesh/instance-name", "POST", { instanceName })
    ).status,
    updateMeshEndpoint: async (meshEndpoint) => (
      await mutate("/api/mesh/endpoint", "POST", { meshEndpoint })
    ).status,
    createEnrollmentToken,
    revokeWorker: async (workerNodeId) => (
      await mutate("/api/mesh/workers/revoke", "POST", { workerNodeId })
    ).succeeded,
    killWorker: async (workerNodeId) => (
      await mutate(`/api/mesh/workers/${encodeURIComponent(workerNodeId)}/kill`, "POST")
    ).status,
    removeRevokedWorker: async (workerNodeId) => (
      await mutate(`/api/mesh/workers/${encodeURIComponent(workerNodeId)}`, "DELETE")
    ).status,
    checkHealth: async () => (await mutate("/api/mesh/health", "POST")).status,
  };
}
