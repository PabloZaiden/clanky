/**
 * Server settings types for Clanky Tasks Management System.
 * Defines workspace settings for agent and deterministic execution channels.
 */

import type { SshServer } from "./ssh-server";

export const AGENT_PROVIDER_IDS = ["opencode", "copilot", "codex", "claude", "pi", "grok"] as const;

export type AgentProvider = typeof AGENT_PROVIDER_IDS[number];
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
 *                     This should be passed from the server config (CLANKY_REMOTE_ONLY env var).
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

/** Parse persisted server settings in the current canonical shape. */
export function parseServerSettings(jsonString: string | null): ServerSettings {
  if (!jsonString) {
    throw new Error("Persisted server settings are missing");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (error) {
    throw new Error("Persisted server settings contain invalid JSON", { cause: error });
  }

  if (!isServerSettings(parsed)) {
    throw new Error("Persisted server settings do not match the current shape");
  }
  return parsed;
}

function isServerSettings(value: unknown): value is ServerSettings {
  if (!value || typeof value !== "object") {
    return false;
  }
  const agent = (value as Record<string, unknown>)["agent"];
  if (!agent || typeof agent !== "object") {
    return false;
  }
  const agentRecord = agent as Record<string, unknown>;
  if (
    typeof agentRecord["provider"] !== "string"
    || !AGENT_PROVIDER_IDS.includes(agentRecord["provider"] as AgentProvider)
  ) {
    return false;
  }

  if (agentRecord["transport"] === "stdio") {
    return true;
  }
  if (
    agentRecord["transport"] !== "ssh"
    || typeof agentRecord["hostname"] !== "string"
    || agentRecord["hostname"].trim().length === 0
  ) {
    return false;
  }
  if (
    agentRecord["port"] !== undefined
    && (typeof agentRecord["port"] !== "number"
      || !Number.isInteger(agentRecord["port"])
      || agentRecord["port"] < 1
      || agentRecord["port"] > 65535)
  ) {
    return false;
  }
  return ["username", "password", "identityFile"].every(
    (key) => agentRecord[key] === undefined || typeof agentRecord[key] === "string",
  );
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
