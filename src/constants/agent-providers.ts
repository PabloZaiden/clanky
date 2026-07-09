import { AGENT_PROVIDER_IDS } from "@/shared";
import type { AgentProvider } from "../types/settings";

export interface AgentProviderOption {
  id: AgentProvider;
  label: string;
}

const AGENT_PROVIDER_LABELS = {
  opencode: "OpenCode",
  copilot: "Copilot",
  codex: "Codex",
  claude: "Claude Code",
  pi: "Pi",
  grok: "Grok Build",
} satisfies Record<AgentProvider, string>;

export const AGENT_PROVIDER_OPTIONS: readonly AgentProviderOption[] = AGENT_PROVIDER_IDS.map((id) => ({
  id,
  label: AGENT_PROVIDER_LABELS[id],
}));

export { AGENT_PROVIDER_IDS };
