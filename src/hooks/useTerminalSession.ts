/**
 * Hook for a single workspace terminal session detail view.
 */

import { useCallback, useState } from "react";
import type { TerminalSession } from "@/shared";
import type { UpdateTerminalSessionRequest } from "@/contracts";
import { createLogger, useLiveQuery } from "@pablozaiden/webapp/web";
import { ApiError } from "../lib/api-error";
import { apiRequest } from "../lib/api-client";

export interface UseTerminalSessionResult {
  session: TerminalSession | null;
  loading: boolean;
  error: string | null;
  notFound: boolean;
  refresh: () => Promise<void>;
  updateSession: (request: UpdateTerminalSessionRequest) => Promise<TerminalSession>;
  deleteSession: () => Promise<boolean>;
}

const log = createLogger("useTerminalSession");

export function useTerminalSession(sessionId: string): UseTerminalSessionResult {
  const [mutationError, setMutationError] = useState<{ sessionId: string; message: string } | null>(null);
  const query = useLiveQuery<TerminalSession | null>({
    load: async (signal) => {
      try {
        return await apiRequest<TerminalSession>(`/api/terminal-sessions/${sessionId}`, {
          signal,
          action: "Fetch terminal session",
          fallbackMessage: "Failed to fetch terminal session",
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    deps: [sessionId],
    realtime: {
      resources: ["terminal-sessions"],
      ids: [sessionId],
    },
  });
  const mutate = query.mutate;
  const refresh = useCallback(async () => {
    setMutationError(null);
    await query.refresh();
  }, [query.refresh]);

  const updateSession = useCallback(async (request: UpdateTerminalSessionRequest): Promise<TerminalSession> => {
    try {
      setMutationError(null);
      return await mutate((signal) => apiRequest<TerminalSession>(`/api/terminal-sessions/${sessionId}`, {
        signal,
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        action: "Update terminal session",
        fallbackMessage: "Failed to update terminal session",
      }), (_previous, updated) => updated);
    } catch (error) {
      log.error("Failed to update terminal session", { sessionId, error: String(error) });
      setMutationError({ sessionId, message: String(error) });
      throw error instanceof Error ? error : new Error(String(error));
    }
  }, [mutate, sessionId]);

  const deleteSession = useCallback(async (): Promise<boolean> => {
    try {
      setMutationError(null);
      await mutate((signal) => apiRequest<unknown>(`/api/terminal-sessions/${sessionId}`, {
        signal,
        method: "DELETE",
        action: "Delete terminal session",
        fallbackMessage: "Failed to delete terminal session",
      }), () => null);
      return true;
    } catch (error) {
      log.error("Failed to delete terminal session", { sessionId, error: String(error) });
      setMutationError({ sessionId, message: String(error) });
      return false;
    }
  }, [mutate, sessionId]);

  return {
    session: query.data ?? null,
    loading: query.data === undefined && query.loading,
    error: mutationError?.sessionId === sessionId ? mutationError.message : query.error ? String(query.error) : null,
    notFound: query.data === null,
    refresh,
    updateSession,
    deleteSession,
  };
}
