/**
 * Hook for a single SSH session detail view.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SshServerSession, SshSession } from "@/shared";
import type { UpdateSshSessionRequest } from "@/contracts";
import { createClientLogger } from "../lib/client-logger";
import { useRealtimeRefreshWithRecovery } from "./useRealtimeStream";
import { appFetch } from "../lib/public-path";
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
  const log = createClientLogger("useSshSession");
  const [session, setSession] = useState<AnySshSession | null>(null);
  const [sessionKind, setSessionKind] = useState<SshSessionKind | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const initialLoadDoneRef = useRef(false);
  const sessionKindRef = useRef<SshSessionKind | null>(null);

  const fetchSessionByKind = useCallback(async (kind: SshSessionKind): Promise<AnySshSession> => {
    const endpoint = kind === "standalone"
      ? `/api/ssh-server-sessions/${sessionId}`
      : `/api/ssh-sessions/${sessionId}`;
    const response = await appFetch(endpoint);
    if (!response.ok) {
      const data = await response.json() as { message?: string };
      throw new Error(data.message || "Failed to fetch SSH session");
    }
    return await response.json() as AnySshSession;
  }, [sessionId]);

  const fetchSession = useCallback(async (): Promise<{ session: AnySshSession; kind: SshSessionKind }> => {
    if (sessionKindRef.current) {
      return {
        session: await fetchSessionByKind(sessionKindRef.current),
        kind: sessionKindRef.current,
      };
    }

    const workspaceResponse = await appFetch(`/api/ssh-sessions/${sessionId}`);
    if (workspaceResponse.ok) {
      return {
        session: await workspaceResponse.json() as SshSession,
        kind: "workspace",
      };
    }
    if (workspaceResponse.status !== 404) {
      const data = await workspaceResponse.json() as { message?: string };
      throw new Error(data.message || "Failed to fetch SSH session");
    }

    const standaloneResponse = await appFetch(`/api/ssh-server-sessions/${sessionId}`);
    if (!standaloneResponse.ok) {
      const data = await standaloneResponse.json() as { message?: string };
      throw new Error(data.message || "Failed to fetch SSH session");
    }
    return {
      session: await standaloneResponse.json() as SshServerSession,
      kind: "standalone",
    };
  }, [fetchSessionByKind, sessionId]);

  const refreshInternal = useCallback(async (showLoading: boolean) => {
    try {
      if (showLoading) {
        setLoading(true);
      }
      setError(null);
      const next = await fetchSession();
      setSession(next.session);
      sessionKindRef.current = next.kind;
      setSessionKind(next.kind);
      initialLoadDoneRef.current = true;
    } catch (err) {
      log.error("Failed to refresh SSH session", { sessionId, error: String(err) });
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [fetchSession]);

  const refresh = useCallback(async () => {
    await refreshInternal(!initialLoadDoneRef.current);
  }, [refreshInternal]);

  useRealtimeRefreshWithRecovery({
    resources: ["ssh-sessions"],
    ids: [sessionId],
    filters: { resource: "ssh-sessions", id: sessionId },
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
      const response = await appFetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        const data = await response.json() as { message?: string };
        throw new Error(data.message || "Failed to update SSH session");
      }
      const updated = await response.json() as AnySshSession;
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
      const response = await appFetch(`/api/ssh-sessions/${sessionId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const data = await response.json() as { message?: string };
        throw new Error(data.message || "Failed to delete SSH session");
      }
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
    setSession(null);
    setSessionKind(null);
    setLoading(true);
    setError(null);
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
