import { useCallback, useEffect, useRef, useState } from "react";
import type { SshServer } from "@/shared";
import type { CreateSshServerRequest, UpdateSshServerRequest } from "@/contracts";
import { useRealtimeRefreshWithRecovery } from "./useRealtimeStream";
import {
  createSshServerApi,
  deleteSshServerApi,
  listSshServersApi,
  saveStandaloneSshServerPassword,
  updateSshServerApi,
} from "./sshServerActions";
import {
  clearStoredSshServerCredential,
  getStoredSshServerCredential,
} from "../lib/ssh-browser-credentials";
import { createRefreshCoordinator } from "../lib/refresh-coordinator";
import type { ResourceRefreshOptions } from "./useResourceRefresh";

export interface UseSshServersResult {
  servers: SshServer[];
  loading: boolean;
  error: string | null;
  refresh: (options?: ResourceRefreshOptions) => Promise<void>;
  createServer: (request: CreateSshServerRequest, password?: string) => Promise<SshServer | null>;
  updateServer: (id: string, request?: UpdateSshServerRequest, password?: string) => Promise<SshServer | null>;
  deleteServer: (id: string) => Promise<boolean>;
  hasStoredCredential: (serverId: string) => boolean;
}

export interface UseSshServersOptions {
  realtime?: boolean;
}

export function useSshServers({ realtime = true }: UseSshServersOptions = {}): UseSshServersResult {
  const [servers, setServers] = useState<SshServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshCoordinatorRef = useRef(createRefreshCoordinator<void>());

  const refresh = useCallback((options: { showLoading?: boolean } = {}) => {
    return refreshCoordinatorRef.current.run(async () => {
      const showLoading = options.showLoading ?? true;
      try {
        if (showLoading) {
          setLoading(true);
        }
        setError(null);
        const nextServers = await listSshServersApi();
        setServers(nextServers);
      } catch (err) {
        setError(String(err));
      } finally {
        if (showLoading) {
          setLoading(false);
        }
      }
    });
  }, []);

  const createServer = useCallback(async (request: CreateSshServerRequest, password?: string): Promise<SshServer | null> => {
    try {
      setError(null);
      const server = await createSshServerApi(request);
      if (password?.trim()) {
        await saveStandaloneSshServerPassword(server.config.id, password);
      }
      setServers((prev) => [...prev, server].sort((left, right) => left.config.name.localeCompare(right.config.name)));
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
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    }
  }, []);

  useRealtimeRefreshWithRecovery({
    resources: ["execution-hosts"],
    filters: { resource: "execution-hosts" },
    enabled: realtime,
    refresh: () => refresh({ showLoading: false }),
    onReconnect: () => refresh({ showLoading: false }),
  });

  useEffect(() => {
    void refresh();
    return () => {
      refreshCoordinatorRef.current.reset();
    };
  }, [refresh]);

  return {
    servers,
    loading,
    error,
    refresh,
    createServer,
    updateServer,
    deleteServer,
    hasStoredCredential: (serverId: string) => getStoredSshServerCredential(serverId) !== null,
  };
}
