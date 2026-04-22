import { useCallback, useEffect, useState } from "react";
import type {
  CreateSshServerRequest,
  SshConnectionMode,
  SshServer,
  SshServerSession,
  UpdateSshServerRequest,
} from "../types";
import {
  createStandaloneSshSessionApi,
  createSshServerApi,
  deleteSshServerApi,
  listSshServerSessionsApi,
  listSshServersApi,
  saveStandaloneSshServerPassword,
  updateSshServerApi,
} from "./sshServerActions";
import {
  clearStoredSshServerCredential,
  getStoredSshServerCredential,
} from "../lib/ssh-browser-credentials";

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
    hasStoredCredential: (serverId: string) => getStoredSshServerCredential(serverId) !== null,
  };
}
