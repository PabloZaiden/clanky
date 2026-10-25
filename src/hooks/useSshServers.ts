import { useCallback, useState } from "react";
import type { SshServer } from "@/shared";
import type { CreateSshServerRequest, UpdateSshServerRequest } from "@/contracts";
import { useLiveQuery } from "@pablozaiden/webapp/web";
import {
  createSshServerApi,
  deleteSshServerApi,
  saveStandaloneSshServerPassword,
  updateSshServerApi,
} from "./sshServerActions";
import {
  clearStoredSshServerCredential,
  getStoredSshServerCredential,
} from "../lib/ssh-browser-credentials";
import { apiRequest } from "../lib/api-client";

export interface UseSshServersResult {
  servers: SshServer[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createServer: (request: CreateSshServerRequest, password?: string) => Promise<SshServer | null>;
  updateServer: (id: string, request?: UpdateSshServerRequest, password?: string) => Promise<SshServer | null>;
  deleteServer: (id: string) => Promise<boolean>;
  hasStoredCredential: (serverId: string) => boolean;
}

export interface UseSshServersOptions {
  realtime?: boolean;
  enabled?: boolean;
}

export function useSshServers({ realtime = true, enabled = true }: UseSshServersOptions = {}): UseSshServersResult {
  const [error, setError] = useState<string | null>(null);
  const query = useLiveQuery<SshServer[]>({
    enabled,
    load: (signal) => apiRequest<SshServer[]>("/api/ssh-servers", {
      signal,
      action: "List SSH servers",
      fallbackMessage: "Failed to list SSH servers",
    }),
    realtime: { resources: ["execution-hosts"], enabled: realtime },
  });
  const servers = query.data ?? [];
  const mutate = query.mutate;
  const refresh = useCallback(async () => {
    setError(null);
    await query.refresh();
  }, [query.refresh]);

  const createServer = useCallback(async (request: CreateSshServerRequest, password?: string): Promise<SshServer | null> => {
    try {
      setError(null);
      return await mutate(async () => {
        const server = await createSshServerApi(request);
        if (password?.trim()) {
          await saveStandaloneSshServerPassword(server.config.id, password);
        }
        return server;
      }, (previous, server) => [...(previous ?? []).filter((item) => item.config.id !== server.config.id), server]
        .sort((left, right) => left.config.name.localeCompare(right.config.name)));
    } catch (err) {
      setError(String(err));
      return null;
    }
  }, [mutate]);

  const updateServer = useCallback(async (
    id: string,
    request?: UpdateSshServerRequest,
    password?: string,
  ): Promise<SshServer | null> => {
    try {
      setError(null);
      return await mutate(async () => {
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
        return server;
      }, (previous, server) => request && Object.keys(request).length > 0
        ? previous?.map((item) => item.config.id === id ? server : item)
          .sort((left, right) => left.config.name.localeCompare(right.config.name))
        : previous);
    } catch (err) {
      setError(String(err));
      return null;
    }
  }, [mutate, servers]);

  const deleteServer = useCallback(async (id: string): Promise<boolean> => {
    try {
      setError(null);
      await mutate(async () => {
        await deleteSshServerApi(id);
        clearStoredSshServerCredential(id);
      }, (previous) => previous?.filter((server) => server.config.id !== id));
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    }
  }, [mutate]);

  return {
    servers,
    loading: query.data === undefined && query.loading,
    error: error ?? (query.error ? String(query.error) : null),
    refresh,
    createServer,
    updateServer,
    deleteServer,
    hasStoredCredential: (serverId: string) => getStoredSshServerCredential(serverId) !== null,
  };
}
