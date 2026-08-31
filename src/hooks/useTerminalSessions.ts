/**
 * Hook for managing workspace terminal sessions with real-time updates.
 */

import { useCallback, useEffect, useState } from "react";
import type { WorkspaceTerminalSession } from "@/shared";
import type { CreateTerminalSessionRequest, UpdateTerminalSessionRequest } from "@/contracts";
import { createLogger } from "@pablozaiden/webapp/web";
import { useRealtimeRefreshWithRecovery } from "./useRealtimeStream";
import { apiRequest } from "../lib/api-client";
import { useResourceRefresh, type ResourceRefreshOptions } from "./useResourceRefresh";

export interface UseTerminalSessionsResult {
  sessions: WorkspaceTerminalSession[];
  loading: boolean;
  error: string | null;
  refresh: (options?: ResourceRefreshOptions) => Promise<void>;
  createSession: (request: CreateTerminalSessionRequest) => Promise<WorkspaceTerminalSession>;
  updateSession: (id: string, request: UpdateTerminalSessionRequest) => Promise<WorkspaceTerminalSession>;
  deleteSession: (id: string) => Promise<boolean>;
  getSession: (id: string) => WorkspaceTerminalSession | undefined;
}

export interface UseTerminalSessionsOptions {
  realtime?: boolean;
}

export function useTerminalSessions({ realtime = true }: UseTerminalSessionsOptions = {}): UseTerminalSessionsResult {
  const log = createLogger("useTerminalSessions");
  const [sessions, setSessions] = useState<WorkspaceTerminalSession[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadSessions = useCallback(async (signal: AbortSignal): Promise<WorkspaceTerminalSession[]> => {
    return await apiRequest<WorkspaceTerminalSession[]>("/api/terminal-sessions", {
      signal,
      action: "Fetch terminal sessions",
      fallbackMessage: "Failed to fetch terminal sessions",
    });
  }, []);

  const handleRefreshError = useCallback((refreshError: unknown) => {
    log.error("Failed to fetch terminal sessions", { error: String(refreshError) });
    setError(String(refreshError));
  }, []);

  const refreshResource = useResourceRefresh({
    load: loadSessions,
    onLoaded: setSessions,
    onRefreshStart: () => setError(null),
    onError: handleRefreshError,
  });

  const refresh = useCallback(async (options: ResourceRefreshOptions = {}) => {
    await refreshResource.refresh(options);
  }, [refreshResource.refresh]);

  const refreshInBackground = useCallback(() => refresh({ showLoading: false }), [refresh]);

  const createSession = useCallback(async (request: CreateTerminalSessionRequest): Promise<WorkspaceTerminalSession> => {
    try {
      setError(null);
      const session = await apiRequest<WorkspaceTerminalSession>("/api/terminal-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        action: "Create terminal session",
        fallbackMessage: "Failed to create terminal session",
      });
      setSessions((prev) => [session, ...prev.filter((item) => item.config.id !== session.config.id)]);
      return session;
    } catch (err) {
      const message = String(err);
      log.error("Failed to create terminal session", { error: message });
      setError(message);
      throw err instanceof Error ? err : new Error(message);
    }
  }, []);

  const updateSession = useCallback(async (id: string, request: UpdateTerminalSessionRequest): Promise<WorkspaceTerminalSession> => {
    try {
      setError(null);
      const session = await apiRequest<WorkspaceTerminalSession>(`/api/terminal-sessions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        action: "Update terminal session",
        fallbackMessage: "Failed to update terminal session",
      });
      setSessions((prev) => prev.map((item) => item.config.id === id ? session : item));
      return session;
    } catch (err) {
      const message = String(err);
      log.error("Failed to update terminal session", { terminalSessionId: id, error: message });
      setError(message);
      throw err instanceof Error ? err : new Error(message);
    }
  }, []);

  const deleteSession = useCallback(async (id: string): Promise<boolean> => {
    try {
      setError(null);
      await apiRequest<unknown>(`/api/terminal-sessions/${id}`, {
        method: "DELETE",
        action: "Delete terminal session",
        fallbackMessage: "Failed to delete terminal session",
      });
      setSessions((prev) => prev.filter((item) => item.config.id !== id));
      return true;
    } catch (err) {
      log.error("Failed to delete terminal session", { terminalSessionId: id, error: String(err) });
      setError(String(err));
      return false;
    }
  }, []);

  useRealtimeRefreshWithRecovery({
    resources: ["terminal-sessions"],
    filters: { resource: "terminal-sessions" },
    enabled: realtime,
    refresh: refreshInBackground,
    onReconnect: refreshInBackground,
  });

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    sessions,
    loading: refreshResource.loading,
    error,
    refresh,
    createSession,
    updateSession,
    deleteSession,
    getSession: (id: string) => sessions.find((session) => session.config.id === id),
  };
}
