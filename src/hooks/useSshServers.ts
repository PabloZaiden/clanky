import { useCallback, useEffect, useState } from "react";
import type {
  CreateSshServerRequest,
  SshConnectionMode,
  SshServer,
  SshServerSession,
  SshSessionEvent,
  UpdateSshServerRequest,
} from "../types";
import { isSshSessionEvent, useAppEvents } from "./useAppEvents";
import {
  createStandaloneSshSessionApi,
  createSshServerApi,
  deleteStandaloneSshSessionApi,
  deleteSshServerApi,
  listSshServerSessionsApi,
  listSshServersApi,
  saveStandaloneSshServerPassword,
  updateStandaloneSshSessionApi,
  updateSshServerApi,
} from "./sshServerActions";
import {
  clearStoredSshServerCredential,
  getStoredSshServerCredential,
} from "../lib/ssh-browser-credentials";

function applyStandaloneSshSessionStatus(
  sessionsByServerId: Record<string, SshServerSession[]>,
  sessionId: string,
  status: SshServerSession["state"]["status"],
  error: string | undefined,
): Record<string, SshServerSession[]> {
  let changed = false;
  const nextEntries = Object.entries(sessionsByServerId).map(([serverId, sessions]) => {
    const nextSessions = sessions.map((session) => {
      if (session.config.id !== sessionId) {
        return session;
      }
      changed = true;
      return {
        ...session,
        state: {
          ...session.state,
          status,
          error,
        },
      };
    });
    return [serverId, nextSessions] as const;
  });
  return changed ? Object.fromEntries(nextEntries) : sessionsByServerId;
}

function removeStandaloneSshSession(
  sessionsByServerId: Record<string, SshServerSession[]>,
  sessionId: string,
): Record<string, SshServerSession[]> {
  let changed = false;
  const nextEntries = Object.entries(sessionsByServerId).map(([serverId, sessions]) => {
    const nextSessions = sessions.filter((session) => session.config.id !== sessionId);
    if (nextSessions.length !== sessions.length) {
      changed = true;
    }
    return [serverId, nextSessions] as const;
  });
  return changed ? Object.fromEntries(nextEntries) : sessionsByServerId;
}

export interface UseSshServersResult {
  servers: SshServer[];
  sessionsByServerId: Record<string, SshServerSession[]>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createServer: (request: CreateSshServerRequest, password?: string) => Promise<SshServer | null>;
  updateServer: (id: string, request?: UpdateSshServerRequest, password?: string) => Promise<SshServer | null>;
  deleteServer: (id: string) => Promise<boolean>;
  createSession: (
    serverId: string,
    options?: { name?: string; connectionMode?: SshConnectionMode; useTmux?: boolean },
  ) => Promise<SshServerSession>;
  updateSession: (serverId: string, sessionId: string, request: { name?: string }) => Promise<SshServerSession>;
  deleteSession: (serverId: string, sessionId: string) => Promise<boolean>;
  hasStoredCredential: (serverId: string) => boolean;
}

export function useSshServers(): UseSshServersResult {
  const [servers, setServers] = useState<SshServer[]>([]);
  const [sessionsByServerId, setSessionsByServerId] = useState<Record<string, SshServerSession[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const nextServers = await listSshServersApi();
      const sessionEntries = await Promise.all(nextServers.map(async (server) => {
        return [server.config.id, await listSshServerSessionsApi(server.config.id)] as const;
      }));
      setServers(nextServers);
      setSessionsByServerId(Object.fromEntries(sessionEntries));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const createServer = useCallback(async (request: CreateSshServerRequest, password?: string): Promise<SshServer | null> => {
    try {
      setError(null);
      const server = await createSshServerApi(request);
      if (password?.trim()) {
        await saveStandaloneSshServerPassword(server.config.id, password);
      }
      setServers((prev) => [...prev, server].sort((left, right) => left.config.name.localeCompare(right.config.name)));
      setSessionsByServerId((prev) => ({ ...prev, [server.config.id]: [] }));
      return server;
    } catch (err) {
      setError(String(err));
      return null;
    }
  }, []);

  const updateServer = useCallback(async (
    id: string,
    request?: UpdateSshServerRequest,
    password?: string,
  ): Promise<SshServer | null> => {
    try {
      setError(null);
      const currentServer = servers.find((item) => item.config.id === id) ?? null;
      const server = request && Object.keys(request).length > 0
        ? await updateSshServerApi(id, request)
        : currentServer;
      if (!server) {
        throw new Error("SSH server not found");
      }
      if (password?.trim()) {
        await saveStandaloneSshServerPassword(server.config.id, password);
      }
      setServers((prev) =>
        prev
          .map((item) => item.config.id === id ? server : item)
          .sort((left, right) => left.config.name.localeCompare(right.config.name)),
      );
      return server;
    } catch (err) {
      setError(String(err));
      return null;
    }
  }, [servers]);

  const deleteServer = useCallback(async (id: string): Promise<boolean> => {
    try {
      setError(null);
      await deleteSshServerApi(id);
      clearStoredSshServerCredential(id);
      setServers((prev) => prev.filter((server) => server.config.id !== id));
      setSessionsByServerId((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    }
  }, []);

  const createSession = useCallback(async (
    serverId: string,
    options: { name?: string; connectionMode?: SshConnectionMode; useTmux?: boolean } = {},
  ): Promise<SshServerSession> => {
    try {
      setError(null);
      const session = await createStandaloneSshSessionApi({
        serverId,
        name: options.name ?? "SSH session",
        connectionMode: options.connectionMode ?? "dtach",
        useTmux: options.useTmux,
      });
      setSessionsByServerId((prev) => ({
        ...prev,
        [serverId]: [session, ...(prev[serverId] ?? [])],
      }));
      return session;
    } catch (err) {
      const message = String(err);
      setError(message);
      throw err instanceof Error ? err : new Error(message);
    }
  }, []);

  const updateSession = useCallback(async (
    serverId: string,
    sessionId: string,
    request: { name?: string },
  ): Promise<SshServerSession> => {
    try {
      setError(null);
      const session = await updateStandaloneSshSessionApi(sessionId, request);
      setSessionsByServerId((prev) => ({
        ...prev,
        [serverId]: (prev[serverId] ?? []).map((item) => item.config.id === sessionId ? session : item),
      }));
      return session;
    } catch (err) {
      const message = String(err);
      setError(message);
      throw err instanceof Error ? err : new Error(message);
    }
  }, []);

  const deleteSession = useCallback(async (serverId: string, sessionId: string): Promise<boolean> => {
    try {
      setError(null);
      await deleteStandaloneSshSessionApi({
        serverId,
        sessionId,
        requireCredential: false,
      });
      setSessionsByServerId((prev) => ({
        ...prev,
        [serverId]: (prev[serverId] ?? []).filter((session) => session.config.id !== sessionId),
      }));
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    }
  }, []);

  const handleSshSessionEvent = useCallback((event: SshSessionEvent) => {
    if (!event.sshSessionId) {
      return;
    }
    if (event.type === "ssh_session.deleted") {
      setSessionsByServerId((prev) => removeStandaloneSshSession(prev, event.sshSessionId));
      return;
    }
    if (event.type === "ssh_session.status") {
      setSessionsByServerId((prev) => applyStandaloneSshSessionStatus(prev, event.sshSessionId, event.status, event.error));
    }
  }, []);

  useAppEvents<SshSessionEvent>(handleSshSessionEvent, isSshSessionEvent);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    servers,
    sessionsByServerId,
    loading,
    error,
    refresh,
    createServer,
    updateServer,
    deleteServer,
    createSession,
    updateSession,
    deleteSession,
    hasStoredCredential: (serverId: string) => getStoredSshServerCredential(serverId) !== null,
  };
}
