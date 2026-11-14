import { AGENT_PROVIDER_IDS } from "@/shared";
import type { AgentProvider } from "@/shared/settings";

export interface AgentProviderOption {
  id: AgentProvider;
  label: string;
}

const AGENT_PROVIDER_LABELS = {
  opencode: "OpenCode 2",
  copilot: "Copilot",
  codex: "Codex",
} satisfies Record<AgentProvider, string>;

export const AGENT_PROVIDER_OPTIONS: readonly AgentProviderOption[] = AGENT_PROVIDER_IDS.map((id) => ({
  id,
  label: AGENT_PROVIDER_LABELS[id],
}));

export { AGENT_PROVIDER_IDS };
