/**
 * Hook for managing SSH sessions with real-time updates.
 */

import { useCallback, useEffect, useState } from "react";
import type { SshSession } from "@/shared";
import type { CreateSshSessionRequest, UpdateSshSessionRequest } from "@/contracts";
import { createLogger } from "@pablozaiden/webapp/web";
import { useRealtimeRefreshWithRecovery } from "./useRealtimeStream";
import { appFetch } from "../lib/public-path";

export interface UseSshSessionsResult {
  sessions: SshSession[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createSession: (request: CreateSshSessionRequest) => Promise<SshSession>;
  updateSession: (id: string, request: UpdateSshSessionRequest) => Promise<SshSession>;
  deleteSession: (id: string) => Promise<boolean>;
  getSession: (id: string) => SshSession | undefined;
}

export function useSshSessions(): UseSshSessionsResult {
  const log = createLogger("useSshSessions");
  const [sessions, setSessions] = useState<SshSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (options: { showLoading?: boolean } = {}) => {
    const showLoading = options.showLoading ?? true;
    try {
      if (showLoading) {
        setLoading(true);
      }
      setError(null);
      const response = await appFetch("/api/ssh-sessions");
      if (!response.ok) {
        const data = await response.json() as { message?: string };
        throw new Error(data.message || "Failed to fetch SSH sessions");
      }
      const data = await response.json() as SshSession[];
      setSessions(data);
    } catch (err) {
      log.error("Failed to fetch SSH sessions", { error: String(err) });
      setError(String(err));
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, []);

  useRealtimeRefreshWithRecovery({
    resources: ["ssh-sessions"],
    filters: { resource: "ssh-sessions" },
    refresh: () => refresh({ showLoading: false }),
    onReconnect: () => refresh({ showLoading: false }),
  });

  const createSession = useCallback(async (request: CreateSshSessionRequest): Promise<SshSession> => {
    try {
      setError(null);
      const response = await appFetch("/api/ssh-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        const data = await response.json() as { message?: string };
        throw new Error(data.message || "Failed to create SSH session");
      }
      const session = await response.json() as SshSession;
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
      const response = await appFetch(`/api/ssh-sessions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        const data = await response.json() as { message?: string };
        throw new Error(data.message || "Failed to update SSH session");
      }
      const session = await response.json() as SshSession;
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
      const response = await appFetch(`/api/ssh-sessions/${id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const data = await response.json() as { message?: string };
        throw new Error(data.message || "Failed to delete SSH session");
      }
      setSessions((prev) => prev.filter((item) => item.config.id !== id));
      return true;
    } catch (err) {
      log.error("Failed to delete SSH session", { sshSessionId: id, error: String(err) });
      setError(String(err));
      return false;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    sessions,
    loading,
    error,
    refresh,
    createSession,
    updateSession,
    deleteSession,
    getSession: (id: string) => sessions.find((session) => session.config.id === id),
  };
}
