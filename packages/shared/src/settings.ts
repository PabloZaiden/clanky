/**
 * Server settings types for Ralph Loops Management System.
 * Defines workspace settings for agent and deterministic execution channels.
 */

import type { SshServer } from "./ssh-server";

export type AgentProvider = "opencode" | "copilot";
export type AgentTransport = "stdio" | "ssh";

export type AgentSettings =
  | {
      provider: AgentProvider;
      transport: "stdio";
    }
  | {
      provider: AgentProvider;
      transport: "ssh";
      hostname: string;
      port?: number;
      username?: string;
      password?: string;
      identityFile?: string;
    };

export interface ServerSettings {
  agent: AgentSettings;
}

/**
 * Get default server settings.
 * @param remoteOnly - If true, defaults to `ssh` transport instead of `stdio`.
 *                     This should be passed from the server config (RALPHER_REMOTE_ONLY env var).
 */
export function getDefaultServerSettings(remoteOnly: boolean = false): ServerSettings {
  const defaultAgent = remoteOnly
    ? {
        provider: "opencode" as const,
        transport: "ssh" as const,
        hostname: "127.0.0.1",
        port: 22,
        username: "",
        password: "",
      }
    : {
        provider: "opencode" as const,
        transport: "stdio" as const,
      };

  return {
    agent: defaultAgent,
  };
}

/**
 * Defaults for creating a new workspace from the UI.
 * New workspaces should start on Copilot over SSH, regardless of remote-only mode.
 */
export function getCreateWorkspaceDefaultServerSettings(): ServerSettings {
  return {
    agent: {
      provider: "copilot",
      transport: "ssh",
      hostname: "localhost",
      port: 22,
    },
  };
}

/**
 * Parse persisted server settings with backward compatibility for legacy rows.
 */
export function parseServerSettings(jsonString: string | null): ServerSettings {
  const defaults = getDefaultServerSettings();
  if (!jsonString) {
    return defaults;
  }

  try {
    const parsed = JSON.parse(jsonString) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return defaults;
    }

    const parsedRecord = parsed as Record<string, unknown>;

    if (typeof parsedRecord["mode"] === "string") {
      const mode = parsedRecord["mode"] === "connect" ? "ssh" : "stdio";
      if (mode === "ssh") {
        return {
          agent: {
            provider: "opencode",
            transport: "ssh",
            hostname: typeof parsedRecord["hostname"] === "string" ? parsedRecord["hostname"] : "127.0.0.1",
            port: typeof parsedRecord["port"] === "number" ? parsedRecord["port"] : 22,
            password: typeof parsedRecord["password"] === "string" ? parsedRecord["password"] : undefined,
          },
        };
      }

      return {
        agent: {
          provider: "opencode",
          transport: mode,
        },
      };
    }

    const parsedAgent = parsedRecord["agent"];
    const parsedExecution = parsedRecord["execution"];
    const agent = (parsedAgent && typeof parsedAgent === "object")
      ? parsedAgent as Record<string, unknown>
      : {};
    const execution = (parsedExecution && typeof parsedExecution === "object")
      ? parsedExecution as Record<string, unknown>
      : {};

    const provider = typeof agent["provider"] === "string"
      ? agent["provider"] as ServerSettings["agent"]["provider"]
      : defaults.agent.provider;
    const rawTransport = typeof agent["transport"] === "string" ? agent["transport"] : "stdio";

    if (rawTransport === "ssh") {
      return {
        agent: {
          provider,
          transport: "ssh",
          hostname:
            (typeof agent["hostname"] === "string" && agent["hostname"].trim().length > 0
              ? agent["hostname"]
              : typeof execution["host"] === "string" && execution["host"].trim().length > 0
                ? execution["host"]
                : "127.0.0.1"),
          port:
            typeof execution["port"] === "number"
              ? execution["port"]
              : typeof agent["port"] === "number"
                ? agent["port"]
                : 22,
          username:
            typeof agent["username"] === "string"
              ? agent["username"]
              : typeof execution["user"] === "string"
                ? execution["user"]
                : undefined,
          password: typeof agent["password"] === "string" ? agent["password"] : undefined,
          identityFile:
            typeof agent["identityFile"] === "string" && agent["identityFile"].trim().length > 0
              ? agent["identityFile"]
              : undefined,
        },
      };
    }

    return {
      agent: {
        provider,
        transport: "stdio",
      },
    };
  } catch {
    return defaults;
  }
}

function getComparableServerSettings(settings: ServerSettings): ServerSettings {
  if (settings.agent.transport === "ssh") {
    return {
      agent: {
        provider: settings.agent.provider,
        transport: "ssh",
        hostname: settings.agent.hostname,
        ...(settings.agent.port !== undefined ? { port: settings.agent.port } : {}),
        ...(settings.agent.username !== undefined ? { username: settings.agent.username } : {}),
        ...(settings.agent.password !== undefined ? { password: settings.agent.password } : {}),
        ...(settings.agent.identityFile !== undefined ? { identityFile: settings.agent.identityFile } : {}),
      },
    };
  }

  return {
    agent: {
      provider: settings.agent.provider,
      transport: "stdio",
    },
  };
}

export function areServerSettingsEqual(left: ServerSettings, right: ServerSettings): boolean {
  return JSON.stringify(getComparableServerSettings(left)) === JSON.stringify(getComparableServerSettings(right));
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase();
}

function normalizeUsername(username: string | undefined): string {
  return username?.trim() ?? "";
}

function normalizeSshServerAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function findRegisteredSshServer(
  hostname: string,
  registeredSshServers: readonly SshServer[],
): SshServer | undefined {
  const normalizedHostname = normalizeSshServerAddress(hostname);
  if (!normalizedHostname) {
    return undefined;
  }

  return registeredSshServers.find((server) => {
    return normalizeSshServerAddress(server.config.address) === normalizedHostname;
  });
}

/**
 * Build a deterministic, credential-free fingerprint for workspace routing.
 */
export function getServerFingerprint(settings: ServerSettings): string {
  const provider = settings.agent.provider;

  if (settings.agent.transport === "ssh") {
    const hostname = normalizeHostname(settings.agent.hostname);
    const port = settings.agent.port ?? 22;
    const username = normalizeUsername(settings.agent.username);
    return `${provider}:ssh:${hostname}:${port}:${username}`;
  }

  return `${provider}:stdio`;
}

/**
 * Human-readable server label for disambiguating workspace lists.
 */
export function getServerLabel(
  settings: ServerSettings,
  registeredSshServers: readonly SshServer[] = [],
): string {
  if (settings.agent.transport === "ssh") {
    const hostname = settings.agent.hostname.trim() || "127.0.0.1";
    const port = settings.agent.port ?? 22;
    const username = settings.agent.username?.trim();
    const registeredServer = findRegisteredSshServer(hostname, registeredSshServers);
    const hostDisplay = registeredServer?.config.name ?? hostname;
    const authority = username ? `${username}@${hostDisplay}` : hostDisplay;
    return `${settings.agent.provider} via ssh (${authority}:${port})`;
  }

  return `${settings.agent.provider} via local stdio`;
}

/**
 * Unified workspace connection status.
 * Deterministic execution checks are derived from the selected transport.
 */
export interface ConnectionStatus {
  /** Whether workspace connection is healthy */
  connected: boolean;
  /** Selected agent provider */
  provider: AgentProvider;
  /** Selected transport */
  transport: AgentTransport;
  /** Provider capability list */
  capabilities: string[];
  /** Connected server URL, when applicable */
  serverUrl?: string;
  /** Whether target workspace directory exists */
  directoryExists?: boolean;
  /** Whether target workspace is a git repository */
  isGitRepo?: boolean;
  /** Error message if connection check failed */
  error?: string;
}
