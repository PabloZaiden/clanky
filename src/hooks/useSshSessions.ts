/**
 * Hook for managing SSH sessions with real-time updates.
 */

import { useCallback, useEffect, useState } from "react";
import type { SshSession } from "@/shared";
import type { CreateSshSessionRequest, UpdateSshSessionRequest } from "@/contracts";
import { createLogger } from "@pablozaiden/webapp/web";
import { useRealtimeRefreshWithRecovery } from "./useRealtimeStream";
import { apiRequest } from "../lib/api-client";
import { useResourceRefresh, type ResourceRefreshOptions } from "./useResourceRefresh";

export interface UseSshSessionsResult {
  sessions: SshSession[];
  loading: boolean;
  error: string | null;
  refresh: (options?: ResourceRefreshOptions) => Promise<void>;
  createSession: (request: CreateSshSessionRequest) => Promise<SshSession>;
  updateSession: (id: string, request: UpdateSshSessionRequest) => Promise<SshSession>;
  deleteSession: (id: string) => Promise<boolean>;
  getSession: (id: string) => SshSession | undefined;
}

export interface UseSshSessionsOptions {
  realtime?: boolean;
}

export function useSshSessions({ realtime = true }: UseSshSessionsOptions = {}): UseSshSessionsResult {
  const log = createLogger("useSshSessions");
  const [sessions, setSessions] = useState<SshSession[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadSessions = useCallback(async (signal: AbortSignal): Promise<SshSession[]> => {
    return await apiRequest<SshSession[]>("/api/ssh-sessions", {
      signal,
      action: "Fetch SSH sessions",
      fallbackMessage: "Failed to fetch SSH sessions",
    });
  }, []);

  const handleRefreshError = useCallback((refreshError: unknown) => {
    log.error("Failed to fetch SSH sessions", { error: String(refreshError) });
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

  const createSession = useCallback(async (request: CreateSshSessionRequest): Promise<SshSession> => {
    try {
      setError(null);
      const session = await apiRequest<SshSession>("/api/ssh-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        action: "Create SSH session",
        fallbackMessage: "Failed to create SSH session",
      });
      setSessions((prev) => [session, ...prev.filter((item) => item.config.id !== session.config.id)]);
      return session;
    } catch (err) {
      const message = String(err);
      log.error("Failed to create SSH session", { error: message });
      setError(message);
      throw err instanceof Error ? err : new Error(message);
    }
  }, []);

  const updateSession = useCallback(async (id: string, request: UpdateSshSessionRequest): Promise<SshSession> => {
    try {
      setError(null);
      const session = await apiRequest<SshSession>(`/api/ssh-sessions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        action: "Update SSH session",
        fallbackMessage: "Failed to update SSH session",
      });
      setSessions((prev) => prev.map((item) => item.config.id === id ? session : item));
      return session;
    } catch (err) {
      const message = String(err);
      log.error("Failed to update SSH session", { sshSessionId: id, error: message });
      setError(message);
      throw err instanceof Error ? err : new Error(message);
    }
  }, []);

  const deleteSession = useCallback(async (id: string): Promise<boolean> => {
    try {
      setError(null);
      await apiRequest<unknown>(`/api/ssh-sessions/${id}`, {
        method: "DELETE",
        action: "Delete SSH session",
        fallbackMessage: "Failed to delete SSH session",
      });
      setSessions((prev) => prev.filter((item) => item.config.id !== id));
      return true;
    } catch (err) {
      log.error("Failed to delete SSH session", { sshSessionId: id, error: String(err) });
      setError(String(err));
      return false;
    }
  }, []);

  useRealtimeRefreshWithRecovery({
    resources: ["ssh-sessions", "terminal-sessions"],
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
