import { useCallback, useState } from "react";
import type { MeshControllerStatus } from "@/shared/mesh";
import type { MeshEnrollmentRoute } from "@/contracts/schemas/mesh";
import type { ControllerRelayPairingStatus } from "@/contracts/relay";
import { apiRequest } from "../lib/api-client";
import { useLiveQuery } from "@pablozaiden/webapp/web";

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
  refresh: () => Promise<void>;
  refreshRelayStatus: () => Promise<void>;
  updateInstanceName: (instanceName: string) => Promise<MeshControllerStatus | null>;
  updateMeshEndpoint: (meshEndpoint: string) => Promise<MeshControllerStatus | null>;
  createEnrollmentToken: (
    name: string,
    ttlSeconds?: number,
    route?: MeshEnrollmentRoute,
    relayName?: string,
  ) => Promise<CreatedMeshEnrollment | null>;
  revokeWorker: (workerNodeId: string) => Promise<boolean>;
  killWorker: (workerNodeId: string) => Promise<MeshControllerStatus | null>;
  removeRevokedWorker: (workerNodeId: string) => Promise<MeshControllerStatus | null>;
  checkHealth: () => Promise<MeshControllerStatus | null>;
}

export function useMesh({ enabled = true }: { enabled?: boolean } = {}): UseMeshResult {
  const [saving, setSaving] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const query = useLiveQuery<{
    status: MeshControllerStatus;
    relayStatus: ControllerRelayPairingStatus;
    enrollmentTokens: MeshEnrollmentTokenSummary[];
  }>({
    enabled,
    load: async (signal) => {
      const [status, enrollmentTokens, relayStatus] = await Promise.all([
        apiRequest<MeshControllerStatus>("/api/mesh/status", {
          signal,
          action: "Load Mesh status",
          fallbackMessage: "Failed to load Mesh status",
        }),
        apiRequest<MeshEnrollmentTokenSummary[]>("/api/mesh/enrollment-tokens", {
          signal,
          action: "Load Mesh enrollment tokens",
          fallbackMessage: "Failed to load Mesh enrollment tokens",
        }),
        apiRequest<ControllerRelayPairingStatus>("/api/mesh/relay", {
          signal,
          action: "Load Mesh relay status",
          fallbackMessage: "Failed to load Mesh relay status",
        }),
      ]);
      return { status, enrollmentTokens, relayStatus };
    },
    realtime: { resources: ["mesh"] },
  });
  const mutateQuery = query.mutate;

  const mutate = useCallback(async (
    path: string,
    method: "POST" | "DELETE",
    body?: Record<string, unknown>,
  ): Promise<MeshMutationResult> => {
    setSaving(true);
    setMutationError(null);
    try {
      const status = await mutateQuery(async (signal) => {
        const response = await apiRequest<MeshResponse>(path, {
          signal,
          method,
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
          action: "Update Mesh",
          fallbackMessage: "Failed to update Mesh",
        });
        return response.status ?? await apiRequest<MeshControllerStatus>("/api/mesh/status", {
          signal,
          action: "Load Mesh status",
          fallbackMessage: "Failed to load Mesh status",
        });
      }, (previous, status) => previous ? { ...previous, status } : undefined);
      return { succeeded: true, status };
    } catch (mutationError) {
      const message = mutationError instanceof Error ? mutationError.message : String(mutationError);
      setMutationError(message);
      return { succeeded: false, status: null };
    } finally {
      setSaving(false);
    }
  }, [mutateQuery]);

  const createEnrollmentToken = useCallback(async (
    name: string,
    ttlSeconds = 900,
    route: MeshEnrollmentRoute = "direct",
    relayName?: string,
  ): Promise<CreatedMeshEnrollment | null> => {
    setSaving(true);
    setMutationError(null);
    try {
      return await mutateQuery((signal) => apiRequest<CreatedMeshEnrollment>("/api/mesh/enrollment-tokens", {
        signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          ttlSeconds,
          route,
          ...(relayName ? { relayName } : {}),
        }),
        action: "Create Mesh enrollment token",
        fallbackMessage: "Failed to create Mesh enrollment token",
      }), (previous, created) => previous ? {
        ...previous,
        enrollmentTokens: [...previous.enrollmentTokens, created.enrollment],
      } : undefined);
    } catch (mutationError) {
      setMutationError(mutationError instanceof Error ? mutationError.message : String(mutationError));
      return null;
    } finally {
      setSaving(false);
    }
  }, [mutateQuery]);

  return {
    status: query.data?.status ?? null,
    relayStatus: query.data?.relayStatus ?? null,
    relayStatusLoading: query.data === undefined && query.loading,
    enrollmentTokens: query.data?.enrollmentTokens ?? [],
    loading: query.data === undefined && query.loading,
    saving,
    error: query.error ? String(query.error) : null,
    mutationError,
    refresh: query.refresh,
    refreshRelayStatus: query.refresh,
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
