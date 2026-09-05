/**
 * Server settings types for Clanky Tasks Management System.
 * Defines workspace settings for agent and deterministic execution channels.
 */

import type { ExecutionHostDescriptor, ExecutionHostRef } from "./execution-host";

export const AGENT_PROVIDER_IDS = ["opencode", "copilot", "codex", "claude", "pi", "grok"] as const;

export type AgentProvider = typeof AGENT_PROVIDER_IDS[number];
export type AgentTransport = "stdio" | "ssh";
export const DEFAULT_SERVER_AGENT_PROVIDER: AgentProvider = "opencode";
export const DEFAULT_EXECUTION_AGENT_PROVIDER: AgentProvider = "copilot";

export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === "string"
    && AGENT_PROVIDER_IDS.includes(value as AgentProvider);
}

export interface AgentSettings {
  provider: AgentProvider;
}

export type RuntimeAgentSettings =
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

export interface RuntimeServerSettings {
  agent: RuntimeAgentSettings;
}

export function getDefaultServerSettings(): ServerSettings {
  return {
    agent: {
      provider: DEFAULT_SERVER_AGENT_PROVIDER,
    },
  };
}

export function getDefaultRuntimeServerSettings(
  provider: AgentProvider = DEFAULT_SERVER_AGENT_PROVIDER,
): RuntimeServerSettings {
  return {
    agent: {
      provider,
      transport: "stdio",
    },
  };
}

export function getCreateWorkspaceDefaultServerSettings(): ServerSettings {
  return {
    agent: {
      provider: DEFAULT_EXECUTION_AGENT_PROVIDER,
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
  return typeof agentRecord["provider"] === "string"
    && AGENT_PROVIDER_IDS.includes(agentRecord["provider"] as AgentProvider);
}

export function areServerSettingsEqual(left: ServerSettings, right: ServerSettings): boolean {
  return left.agent.provider === right.agent.provider;
}

/**
 * Human-readable server label for disambiguating workspace lists.
 */
export function getServerLabel(
  settings: ServerSettings,
  executionHost?: Pick<ExecutionHostDescriptor, "name" | "ref"> | null,
): string {
  const hostLabel = executionHost?.name.trim()
    || (executionHost?.ref.kind === "local" ? "local" : "execution host");
  return `${settings.agent.provider} on ${hostLabel}`;
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
  transport: ExecutionHostRef["kind"];
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
  /** Derived availability of the workspace execution host. */
  executionAvailability?: "local" | "remote-connected" | "remote-unavailable" | "unsupported";
}
