import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MeshConflictResolution,
  MeshStatusRecord,
  MeshSyncConflictRecord,
} from "@/shared/mesh";
import { apiRequest } from "../lib/api-client";

interface MeshPreflight {
  linkId: string | null;
  activeNodeId: string | null;
  takeoverGeneration: number | null;
  linkStatus: string | null;
  activeTasks: Array<{ id: string; name: string; status: string }>;
}

interface MeshResponse {
  status?: MeshStatusRecord;
  conflict?: MeshSyncConflictRecord;
  conflicts?: MeshSyncConflictRecord[];
}

export interface UseMeshResult {
  status: MeshStatusRecord | null;
  preflight: MeshPreflight | null;
  conflicts: MeshSyncConflictRecord[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  mutationError: string | null;
  refresh: () => Promise<MeshStatusRecord | null>;
  loadPreflight: () => Promise<MeshPreflight | null>;
  loadConflicts: () => Promise<MeshSyncConflictRecord[]>;
  updateInstanceName: (instanceName: string) => Promise<MeshStatusRecord | null>;
  startPairing: (targetEndpoint: string, targetLocalUserId?: string) => Promise<MeshStatusRecord | null>;
  approvePairing: (requestId: string, linkId?: string) => Promise<MeshStatusRecord | null>;
  completePairing: (requestId: string, fingerprint: string) => Promise<MeshStatusRecord | null>;
  rejectPairing: (requestId: string, reason?: string) => Promise<MeshStatusRecord | null>;
  takeover: (expectedGeneration?: number) => Promise<MeshStatusRecord | null>;
  revokeMember: (nodeId: string) => Promise<MeshStatusRecord | null>;
  removeRevokedMember: (nodeId: string) => Promise<MeshStatusRecord | null>;
  rejoin: (targetEndpoint: string, targetLocalUserId?: string) => Promise<MeshStatusRecord | null>;
  resolveConflict: (
    conflictId: string,
    resolution: MeshConflictResolution,
  ) => Promise<MeshSyncConflictRecord | null>;
}

export function useMesh(): UseMeshResult {
  const [status, setStatus] = useState<MeshStatusRecord | null>(null);
  const [preflight, setPreflight] = useState<MeshPreflight | null>(null);
  const [conflicts, setConflicts] = useState<MeshSyncConflictRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const refreshAbortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async (): Promise<MeshStatusRecord | null> => {
    refreshAbortRef.current?.abort();
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const body = await apiRequest<MeshResponse>("/api/mesh/status", {
        signal: controller.signal,
        action: "Load mesh status",
        fallbackMessage: "Failed to load mesh status",
      });
      if (controller.signal.aborted) {
        return null;
      }
      const nextStatus = (body.status ?? body) as unknown as MeshStatusRecord;
      setStatus(nextStatus);
      return nextStatus;
    } catch (refreshError) {
      if (refreshError instanceof DOMException && refreshError.name === "AbortError") {
        return null;
      }
      setError(String(refreshError));
      return null;
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, []);

  const runMutation = useCallback(async (
    path: string,
    body: Record<string, unknown>,
    fallback: string,
    method: "POST" | "DELETE" = "POST",
  ): Promise<MeshResponse | null> => {
    setSaving(true);
    setError(null);
    setMutationError(null);
    try {
      return await apiRequest<MeshResponse>(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        action: fallback,
        fallbackMessage: fallback,
      });
    } catch (mutationError) {
      const message = mutationError instanceof Error ? mutationError.message : String(mutationError);
      setError(message);
      setMutationError(message);
      return null;
    } finally {
      setSaving(false);
    }
  }, []);

  const loadPreflight = useCallback(async (): Promise<MeshPreflight | null> => {
    try {
      const body = await apiRequest<MeshResponse>("/api/mesh/takeover/preflight", {
        action: "Load mesh takeover preflight",
        fallbackMessage: "Failed to load takeover preflight",
      });
      const result = body as unknown as MeshPreflight;
      setPreflight(result);
      return result;
    } catch (preflightError) {
      setError(String(preflightError));
      return null;
    }
  }, []);

  const loadConflicts = useCallback(async (): Promise<MeshSyncConflictRecord[]> => {
    try {
      const body = await apiRequest<MeshResponse>("/api/mesh/conflicts", {
        action: "Load mesh conflicts",
        fallbackMessage: "Failed to load mesh conflicts",
      });
      const result = body.conflicts ?? [];
      setConflicts(result);
      return result;
    } catch (conflictError) {
      setError(String(conflictError));
      return [];
    }
  }, []);

  const mutationStatus = useCallback(async (
    path: string,
    body: Record<string, unknown>,
    fallback: string,
    method: "POST" | "DELETE" = "POST",
  ): Promise<MeshStatusRecord | null> => {
    const response = await runMutation(path, body, fallback, method);
    if (!response) {
      await refresh();
      return null;
    }
    if (response.status) {
      setStatus(response.status);
      return response.status;
    }
    return await refresh();
  }, [refresh, runMutation]);

  const startPairing = useCallback(
    (targetEndpoint: string, targetLocalUserId?: string) => mutationStatus(
      "/api/mesh/pairing-requests",
      {
        targetEndpoint,
        ...(targetLocalUserId ? { targetLocalUserId } : {}),
      },
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

  const takeover = useCallback(
    (expectedGeneration?: number) => mutationStatus(
      "/api/mesh/takeover",
      expectedGeneration === undefined ? {} : { expectedGeneration },
      "Failed to take over the mesh",
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
      {
        targetEndpoint,
        ...(targetLocalUserId ? { targetLocalUserId } : {}),
      },
      "Failed to rejoin the mesh",
    ),
    [mutationStatus],
  );

  const resolveConflict = useCallback(async (
    conflictId: string,
    resolution: MeshConflictResolution,
  ): Promise<MeshSyncConflictRecord | null> => {
    const response = await runMutation(
      `/api/mesh/conflicts/${encodeURIComponent(conflictId)}/resolve`,
      { resolution },
      "Failed to resolve mesh conflict",
    );
    if (!response?.conflict) {
      return null;
    }
    setConflicts((current) => current.filter((conflict) => conflict.conflictId !== conflictId));
    return response.conflict;
  }, [runMutation]);

  useEffect(() => {
    void refresh();
    return () => refreshAbortRef.current?.abort();
  }, [refresh]);

  return {
    status,
    preflight,
    conflicts,
    loading,
    saving,
    error,
    mutationError,
    refresh,
    loadPreflight,
    loadConflicts,
    updateInstanceName,
    startPairing,
    approvePairing,
    completePairing,
    rejectPairing,
    takeover,
    revokeMember,
    removeRevokedMember,
    rejoin,
    resolveConflict,
  };
}
