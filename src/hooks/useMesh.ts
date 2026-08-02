import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MeshConflictResolution,
  MeshStatusRecord,
  MeshSyncConflictRecord,
} from "@/shared/mesh";
import { appFetch } from "../lib/public-path";

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

async function readResponse(response: Response, fallback: string): Promise<MeshResponse> {
  let body: MeshResponse = {};
  try {
    body = await response.json() as MeshResponse & { message?: string; error?: string };
  } catch {
    if (!response.ok) {
      throw new Error(fallback);
    }
  }
  if (!response.ok) {
    const errorBody = body as MeshResponse & { message?: string; error?: string };
    throw new Error(errorBody.message ?? errorBody.error ?? fallback);
  }
  return body;
}

export interface UseMeshResult {
  status: MeshStatusRecord | null;
  preflight: MeshPreflight | null;
  conflicts: MeshSyncConflictRecord[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  loadPreflight: () => Promise<MeshPreflight | null>;
  loadConflicts: () => Promise<MeshSyncConflictRecord[]>;
  startPairing: (targetEndpoint: string, targetLocalUserId?: string) => Promise<MeshStatusRecord | null>;
  approvePairing: (requestId: string, linkId?: string) => Promise<MeshStatusRecord | null>;
  completePairing: (requestId: string, fingerprint: string) => Promise<MeshStatusRecord | null>;
  rejectPairing: (requestId: string, reason?: string) => Promise<MeshStatusRecord | null>;
  takeover: (expectedGeneration?: number) => Promise<MeshStatusRecord | null>;
  revokeMember: (nodeId: string) => Promise<MeshStatusRecord | null>;
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
  const refreshAbortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    refreshAbortRef.current?.abort();
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await appFetch("/api/mesh/status", { signal: controller.signal });
      if (controller.signal.aborted) {
        return;
      }
      const body = await readResponse(response, "Failed to load mesh status");
      setStatus(body as unknown as MeshStatusRecord);
    } catch (refreshError) {
      if (refreshError instanceof DOMException && refreshError.name === "AbortError") {
        return;
      }
      setError(String(refreshError));
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
  ): Promise<MeshResponse | null> => {
    setSaving(true);
    setError(null);
    try {
      const response = await appFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return await readResponse(response, fallback);
    } catch (mutationError) {
      setError(String(mutationError));
      return null;
    } finally {
      setSaving(false);
    }
  }, []);

  const loadPreflight = useCallback(async (): Promise<MeshPreflight | null> => {
    try {
      const response = await appFetch("/api/mesh/takeover/preflight");
      const body = await readResponse(response, "Failed to load takeover preflight");
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
      const response = await appFetch("/api/mesh/conflicts");
      const body = await readResponse(response, "Failed to load mesh conflicts");
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
  ): Promise<MeshStatusRecord | null> => {
    const response = await runMutation(path, body, fallback);
    if (!response) {
      return null;
    }
    if (response.status) {
      setStatus(response.status);
      return response.status;
    }
    await refresh();
    return status;
  }, [refresh, runMutation, status]);

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
    refresh,
    loadPreflight,
    loadConflicts,
    startPairing,
    approvePairing,
    completePairing,
    rejectPairing,
    takeover,
    revokeMember,
    rejoin,
    resolveConflict,
  };
}
