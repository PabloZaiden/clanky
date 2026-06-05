import type { AgentProvider } from "../types/settings";

export interface AgentProviderOption {
  id: AgentProvider;
  label: string;
}

export const AGENT_PROVIDER_OPTIONS: readonly AgentProviderOption[] = [
  { id: "opencode", label: "OpenCode" },
  { id: "copilot", label: "Copilot" },
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
  { id: "pi", label: "Pi" },
];
