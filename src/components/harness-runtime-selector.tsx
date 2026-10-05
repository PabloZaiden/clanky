import { SelectField } from "@pablozaiden/webapp/web";
import type { AgentProvider, HarnessAdapter } from "@/shared";
import { AGENT_PROVIDER_OPTIONS } from "../constants/agent-providers";

export function HarnessRuntimeSelector({ adapter, provider, supportedAdapters, onAdapterChange, onProviderChange, idPrefix = "" }: {
  adapter: HarnessAdapter;
  provider: AgentProvider;
  supportedAdapters: readonly HarnessAdapter[];
  onAdapterChange: (adapter: HarnessAdapter) => void;
  onProviderChange: (provider: AgentProvider) => void;
  idPrefix?: string;
}) {
  return (
    <>
      <SelectField id={`${idPrefix}harness-adapter`} label="Adapter" value={adapter}
        onChange={(event) => onAdapterChange(event.target.value as HarnessAdapter)}>
        <option value="acp" disabled={!supportedAdapters.includes("acp")}>ACP</option>
        <option value="copilot" disabled={!supportedAdapters.includes("copilot")}>GitHub Copilot</option>
        <option value="codex" disabled={!supportedAdapters.includes("codex")}>Codex</option>
        <option value="opencode2" disabled={!supportedAdapters.includes("opencode2")}>OpenCode 2</option>
      </SelectField>
      {adapter === "acp" && (
        <SelectField id={`${idPrefix}agent-provider`} label="Harness preset" value={provider}
          onChange={(event) => onProviderChange(event.target.value as AgentProvider)}>
          {AGENT_PROVIDER_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </SelectField>
      )}
    </>
  );
}
