/**
 * Hook for a single standalone SSH server session detail view.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SshServerSession } from "@/shared";
import type { UpdateSshServerSessionRequest } from "@/contracts";
import { createLogger } from "@pablozaiden/webapp/web";
import { useRealtimeRefreshWithRecovery } from "./useRealtimeStream";
import { apiRequest } from "../lib/api-client";
import { createRefreshCoordinator } from "../lib/refresh-coordinator";
import { deleteStandaloneSshSessionApi } from "./sshServerActions";

export interface UseSshServerSessionResult {
  session: SshServerSession | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  updateSession: (request: UpdateSshServerSessionRequest) => Promise<SshServerSession>;
  deleteSession: (options?: { password?: string }) => Promise<boolean>;
}

export function useSshServerSession(sessionId: string): UseSshServerSessionResult {
  const log = createLogger("useSshServerSession");
  const [session, setSession] = useState<SshServerSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const initialLoadDoneRef = useRef(false);
  const sessionIdRef = useRef(sessionId);
  const refreshCoordinatorRef = useRef(createRefreshCoordinator<void>());
  sessionIdRef.current = sessionId;

  const fetchSession = useCallback(async (): Promise<SshServerSession> => {
    return await apiRequest<SshServerSession>(`/api/ssh-server-sessions/${sessionId}`, {
      action: "Fetch SSH server session",
      fallbackMessage: "Failed to fetch SSH server session",
    });
  }, [sessionId]);

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
        setSession(next);
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
    resources: ["ssh-server-sessions"],
    ids: [sessionId],
    filters: { id: sessionId },
    enabled: true,
    refresh: (event) => {
      if (event.action === "deleted") {
        setSession(null);
        return;
      }
      return refreshInternal(false);
    },
    onReconnect: () => refreshInternal(false),
  });

  const updateSession = useCallback(async (request: UpdateSshServerSessionRequest): Promise<SshServerSession> => {
    try {
      setError(null);
      const updated = await apiRequest<SshServerSession>(`/api/ssh-server-sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        action: "Update SSH server session",
        fallbackMessage: "Failed to update SSH server session",
      });
      setSession(updated);
      return updated;
    } catch (err) {
      const message = String(err);
      log.error("Failed to update SSH server session", { sessionId, error: message });
      setError(message);
      throw err instanceof Error ? err : new Error(message);
    }
  }, [sessionId]);

  const deleteSession = useCallback(async (options?: { password?: string }): Promise<boolean> => {
    try {
      setError(null);
      if (!session) {
        throw new Error("Standalone SSH server session details are not loaded");
      }
      await deleteStandaloneSshSessionApi({
        sessionId,
        serverId: session.config.sshServerId,
        password: options?.password,
        requireCredential: false,
      });
      setSession(null);
      return true;
    } catch (err) {
      log.error("Failed to delete SSH server session", { sessionId, error: String(err) });
      setError(String(err));
      return false;
    }
  }, [session, sessionId]);

  useEffect(() => {
    initialLoadDoneRef.current = false;
    refreshCoordinatorRef.current.reset();
    setSession(null);
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
    loading,
    error,
    refresh,
    updateSession,
    deleteSession,
  };
}
