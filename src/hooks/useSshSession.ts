/**
 * Hook for a single SSH session detail view.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SshServerSession, SshSession } from "@/shared";
import type { UpdateSshSessionRequest } from "@/contracts";
import { createLogger } from "@pablozaiden/webapp/web";
import { useRealtimeRefreshWithRecovery } from "./useRealtimeStream";
import { apiRequest, readApiResponse, requestApiResponse } from "../lib/api-client";
import { createRefreshCoordinator } from "../lib/refresh-coordinator";
import { deleteStandaloneSshSessionApi } from "./sshServerActions";

export type SshSessionKind = "workspace" | "standalone";
export type AnySshSession = SshSession | SshServerSession;

export interface UseSshSessionResult {
  session: AnySshSession | null;
  sessionKind: SshSessionKind | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  updateSession: (request: UpdateSshSessionRequest) => Promise<AnySshSession>;
  deleteSession: (options?: { password?: string }) => Promise<boolean>;
}

export function useSshSession(sessionId: string): UseSshSessionResult {
  const log = createLogger("useSshSession");
  const [session, setSession] = useState<AnySshSession | null>(null);
  const [sessionKind, setSessionKind] = useState<SshSessionKind | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const initialLoadDoneRef = useRef(false);
  const sessionKindRef = useRef<SshSessionKind | null>(null);
  const sessionIdRef = useRef(sessionId);
  const refreshCoordinatorRef = useRef(createRefreshCoordinator<void>());
  sessionIdRef.current = sessionId;

  const fetchSessionByKind = useCallback(async (kind: SshSessionKind): Promise<AnySshSession> => {
    const endpoint = kind === "standalone"
      ? `/api/ssh-server-sessions/${sessionId}`
      : `/api/ssh-sessions/${sessionId}`;
    return await apiRequest<AnySshSession>(endpoint, {
      action: "Fetch SSH session",
      fallbackMessage: "Failed to fetch SSH session",
    });
  }, [sessionId]);

  const fetchSession = useCallback(async (): Promise<{ session: AnySshSession; kind: SshSessionKind }> => {
    if (sessionKindRef.current) {
      return {
        session: await fetchSessionByKind(sessionKindRef.current),
        kind: sessionKindRef.current,
      };
    }

    const workspaceResponse = await requestApiResponse(`/api/ssh-sessions/${sessionId}`, {
      action: "Fetch workspace SSH session",
      fallbackMessage: "Failed to fetch SSH session",
      acceptedStatuses: [404],
    });
    if (workspaceResponse.status !== 404) {
      return {
        session: await readApiResponse<SshSession>(workspaceResponse),
        kind: "workspace",
      };
    }

    const standaloneResponse = await requestApiResponse(`/api/ssh-server-sessions/${sessionId}`, {
      action: "Fetch standalone SSH session",
      fallbackMessage: "Failed to fetch SSH session",
    });
    return {
      session: await readApiResponse<SshServerSession>(standaloneResponse),
      kind: "standalone",
    };
  }, [fetchSessionByKind, sessionId]);

  const refreshInternal = useCallback((showLoading: boolean) => {
    return refreshCoordinatorRef.current.run(async () => {
      const requestSessionId = sessionId;
      try {
        if (showLoading) {
          setLoading(true);
        }
        setError(null);
        const next = await fetchSession();
        if (sessionIdRef.current !== requestSessionId) {
          return;
        }
        setSession(next.session);
        sessionKindRef.current = next.kind;
        setSessionKind(next.kind);
        initialLoadDoneRef.current = true;
      } catch (err) {
        if (sessionIdRef.current !== requestSessionId) {
          return;
        }
        log.error("Failed to refresh SSH session", { sessionId: requestSessionId, error: String(err) });
        setError(String(err));
      } finally {
        if (sessionIdRef.current === requestSessionId) {
          setLoading(false);
        }
      }
    });
  }, [fetchSession]);

  const refresh = useCallback(async () => {
    await refreshInternal(!initialLoadDoneRef.current);
  }, [refreshInternal]);

  useRealtimeRefreshWithRecovery({
    resources: sessionKind === "standalone"
      ? ["ssh-sessions"]
      : ["ssh-sessions", "terminal-sessions"],
    ids: [sessionId],
    filters: { id: sessionId },
    enabled: sessionKind !== null,
    refresh: (event) => {
      if (event.action === "deleted") {
        setSession(null);
        return;
      }
      return refreshInternal(false);
    },
    onReconnect: () => refreshInternal(false),
  });

  const updateSession = useCallback(async (request: UpdateSshSessionRequest): Promise<AnySshSession> => {
    try {
      setError(null);
      const endpoint = sessionKind === "standalone"
        ? `/api/ssh-server-sessions/${sessionId}`
        : `/api/ssh-sessions/${sessionId}`;
      const updated = await apiRequest<AnySshSession>(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        action: "Update SSH session",
        fallbackMessage: "Failed to update SSH session",
      });
      setSession(updated);
      return updated;
    } catch (err) {
      const message = String(err);
      log.error("Failed to update SSH session", { sessionId, sessionKind, error: message });
      setError(message);
      throw err instanceof Error ? err : new Error(message);
    }
  }, [sessionId, sessionKind]);

  const deleteSession = useCallback(async (options?: { password?: string }): Promise<boolean> => {
    try {
      setError(null);
      if (sessionKind === "standalone") {
        if (!session || !("sshServerId" in session.config)) {
          throw new Error("Standalone SSH session details are not loaded");
        }
        await deleteStandaloneSshSessionApi({
          sessionId,
          serverId: session.config.sshServerId,
          password: options?.password,
          requireCredential: false,
        });
        setSession(null);
        return true;
      }
      await apiRequest<unknown>(`/api/ssh-sessions/${sessionId}`, {
        method: "DELETE",
        action: "Delete SSH session",
        fallbackMessage: "Failed to delete SSH session",
      });
      setSession(null);
      return true;
    } catch (err) {
      log.error("Failed to delete SSH session", { sessionId, sessionKind, error: String(err) });
      setError(String(err));
      return false;
    }
  }, [session, sessionId, sessionKind]);

  useEffect(() => {
    initialLoadDoneRef.current = false;
    sessionKindRef.current = null;
    refreshCoordinatorRef.current.reset();
    setSession(null);
    setSessionKind(null);
    setLoading(true);
    setError(null);
    return () => {
      refreshCoordinatorRef.current.reset();
    };
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    session,
    sessionKind,
    loading,
    error,
    refresh,
    updateSession,
    deleteSession,
  };
}
