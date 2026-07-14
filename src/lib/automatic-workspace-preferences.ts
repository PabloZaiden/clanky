import { createLogger } from "./logger";
import type { SshServer } from "@/shared";

const log = createLogger("automaticWorkspacePreferences");
const LAST_AUTOMATIC_WORKSPACE_SSH_SERVER_STORAGE_KEY = "clanky:last-automatic-workspace-ssh-server-id";
const DEFAULT_AUTOMATIC_WORKSPACE_BASE_PATH = "/workspaces";

interface BrowserStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function resolveStorage(): BrowserStorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch (error) {
    log.warn("Unable to access automatic workspace preferences storage", { error: String(error) });
    return null;
  }
}

export function getLastAutomaticWorkspaceSshServerId(): string | null {
  const storage = resolveStorage();
  if (!storage) {
    return null;
  }

  try {
    return storage.getItem(LAST_AUTOMATIC_WORKSPACE_SSH_SERVER_STORAGE_KEY);
  } catch (error) {
    log.warn("Unable to read last automatic workspace SSH server", { error: String(error) });
    return null;
  }
}

export function saveLastAutomaticWorkspaceSshServerId(serverId: string): void {
  const storage = resolveStorage();
  if (!storage) {
    return;
  }

  try {
    if (serverId) {
      storage.setItem(LAST_AUTOMATIC_WORKSPACE_SSH_SERVER_STORAGE_KEY, serverId);
    } else {
      storage.removeItem(LAST_AUTOMATIC_WORKSPACE_SSH_SERVER_STORAGE_KEY);
    }
  } catch (error) {
    log.warn("Unable to save last automatic workspace SSH server", { error: String(error) });
  }
}

export function getDefaultAutomaticWorkspaceServer(servers: SshServer[]): SshServer | null {
  const lastServerId = getLastAutomaticWorkspaceSshServerId();
  return servers.find((server) => server.config.id === lastServerId) ?? servers[0] ?? null;
}

export function getAutomaticWorkspaceBasePath(server: SshServer | null): string {
  return server?.config.repositoriesBasePath ?? DEFAULT_AUTOMATIC_WORKSPACE_BASE_PATH;
}
