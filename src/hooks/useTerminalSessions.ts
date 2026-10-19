/**
 * Hook for managing workspace terminal sessions with real-time updates.
 */

import { useCallback, useState } from "react";
import type { TerminalSession } from "@/shared";
import type { CreateTerminalSessionRequest, UpdateTerminalSessionRequest } from "@/contracts";
import { createLogger, useLiveQuery } from "@pablozaiden/webapp/web";
import { apiRequest } from "../lib/api-client";

export interface UseTerminalSessionsResult {
  sessions: TerminalSession[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createSession: (request: CreateTerminalSessionRequest) => Promise<TerminalSession>;
  updateSession: (id: string, request: UpdateTerminalSessionRequest) => Promise<TerminalSession>;
  deleteSession: (id: string) => Promise<boolean>;
  getSession: (id: string) => TerminalSession | undefined;
}

export interface UseTerminalSessionsOptions {
  realtime?: boolean;
}

export function useTerminalSessions({ realtime = true }: UseTerminalSessionsOptions = {}): UseTerminalSessionsResult {
  const log = createLogger("useTerminalSessions");
  const [error, setError] = useState<string | null>(null);
  const query = useLiveQuery<TerminalSession[]>({
    load: (signal) => apiRequest<TerminalSession[]>("/api/terminal-sessions", {
      signal,
      action: "Fetch terminal sessions",
      fallbackMessage: "Failed to fetch terminal sessions",
    }),
    realtime: {
      resources: ["terminal-sessions"],
      enabled: realtime,
      onError: (refreshError) => log.error("Failed to fetch terminal sessions", { error: String(refreshError) }),
    },
  });
  const sessions = query.data ?? [];
  const mutate = query.mutate;
  const refresh = useCallback(async () => {
    setError(null);
    await query.refresh();
  }, [query.refresh]);

  const createSession = useCallback(async (request: CreateTerminalSessionRequest): Promise<TerminalSession> => {
    try {
      setError(null);
      return await mutate((signal) => apiRequest<TerminalSession>("/api/terminal-sessions", {
        signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        action: "Create terminal session",
        fallbackMessage: "Failed to create terminal session",
      }), (previous, session) => [session, ...(previous ?? []).filter((item) => item.config.id !== session.config.id)]);
    } catch (err) {
      const message = String(err);
      log.error("Failed to create terminal session", { error: message });
      setError(message);
      throw err instanceof Error ? err : new Error(message);
    }
  }, [mutate]);

  const updateSession = useCallback(async (id: string, request: UpdateTerminalSessionRequest): Promise<TerminalSession> => {
    try {
      setError(null);
      return await mutate((signal) => apiRequest<TerminalSession>(`/api/terminal-sessions/${id}`, {
        signal,
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        action: "Update terminal session",
        fallbackMessage: "Failed to update terminal session",
      }), (previous, session) => previous?.map((item) => item.config.id === id ? session : item));
    } catch (err) {
      const message = String(err);
      log.error("Failed to update terminal session", { terminalSessionId: id, error: message });
      setError(message);
      throw err instanceof Error ? err : new Error(message);
    }
  }, [mutate]);

  const deleteSession = useCallback(async (id: string): Promise<boolean> => {
    try {
      setError(null);
      await mutate((signal) => apiRequest<unknown>(`/api/terminal-sessions/${id}`, {
        signal,
        method: "DELETE",
        action: "Delete terminal session",
        fallbackMessage: "Failed to delete terminal session",
      }), (previous) => previous?.filter((item) => item.config.id !== id));
      return true;
    } catch (err) {
      log.error("Failed to delete terminal session", { terminalSessionId: id, error: String(err) });
      setError(String(err));
      return false;
    }
  }, [mutate]);

  return {
    sessions,
    loading: query.data === undefined && query.loading,
    error: error ?? (query.error ? String(query.error) : null),
    refresh,
    createSession,
    updateSession,
    deleteSession,
    getSession: (id: string) => sessions.find((session) => session.config.id === id),
  };
}
