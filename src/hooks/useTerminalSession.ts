/**
 * Hook for a single workspace terminal session detail view.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalSession } from "@/shared";
import type { UpdateTerminalSessionRequest } from "@/contracts";
import { createLogger } from "@pablozaiden/webapp/web";
import { useRealtimeRefreshWithRecovery } from "./useRealtimeStream";
import { apiRequest } from "../lib/api-client";
import { createRefreshCoordinator } from "../lib/refresh-coordinator";

export interface UseTerminalSessionResult {
  session: TerminalSession | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  updateSession: (request: UpdateTerminalSessionRequest) => Promise<TerminalSession>;
  deleteSession: () => Promise<boolean>;
}

export function useTerminalSession(sessionId: string): UseTerminalSessionResult {
  const log = createLogger("useTerminalSession");
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const initialLoadDoneRef = useRef(false);
  const sessionIdRef = useRef(sessionId);
  const refreshCoordinatorRef = useRef(createRefreshCoordinator<void>());
  sessionIdRef.current = sessionId;

  const fetchSession = useCallback(async (): Promise<TerminalSession> => {
    return await apiRequest<TerminalSession>(`/api/terminal-sessions/${sessionId}`, {
      action: "Fetch terminal session",
      fallbackMessage: "Failed to fetch terminal session",
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
        log.error("Failed to refresh terminal session", { sessionId: requestSessionId, error: String(err) });
        setError(String(err));
      } finally {
        if (sessionIdRef.current === requestSessionId) {
          setLoading(false);
        }
      }
    });
  }, [fetchSession, sessionId]);

  const refresh = useCallback(async () => {
    await refreshInternal(!initialLoadDoneRef.current);
  }, [refreshInternal]);

  useRealtimeRefreshWithRecovery({
    resources: ["terminal-sessions"],
    ids: [sessionId],
    filters: { resource: "terminal-sessions", id: sessionId },
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

  const updateSession = useCallback(async (request: UpdateTerminalSessionRequest): Promise<TerminalSession> => {
    try {
      setError(null);
      const updated = await apiRequest<TerminalSession>(`/api/terminal-sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        action: "Update terminal session",
        fallbackMessage: "Failed to update terminal session",
      });
      setSession(updated);
      return updated;
    } catch (err) {
      const message = String(err);
      log.error("Failed to update terminal session", { sessionId, error: message });
      setError(message);
      throw err instanceof Error ? err : new Error(message);
    }
  }, [sessionId]);

  const deleteSession = useCallback(async (): Promise<boolean> => {
    try {
      setError(null);
      await apiRequest<unknown>(`/api/terminal-sessions/${sessionId}`, {
        method: "DELETE",
        action: "Delete terminal session",
        fallbackMessage: "Failed to delete terminal session",
      });
      setSession(null);
      return true;
    } catch (err) {
      log.error("Failed to delete terminal session", { sessionId, error: String(err) });
      setError(String(err));
      return false;
    }
  }, [sessionId]);

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
