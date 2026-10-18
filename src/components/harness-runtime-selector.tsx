import type { ChangeEvent } from "react";
import { Select, SelectField, SettingsFieldRow } from "@pablozaiden/webapp/web";
import type { AgentProvider, HarnessAdapter } from "@/shared";
import { AGENT_PROVIDER_OPTIONS } from "../constants/agent-providers";

export function HarnessRuntimeSelector({ adapter, provider, supportedAdapters, onAdapterChange, onProviderChange, idPrefix = "", layout = "fields" }: {
  adapter: HarnessAdapter;
  provider: AgentProvider;
  supportedAdapters: readonly HarnessAdapter[];
  onAdapterChange: (adapter: HarnessAdapter) => void;
  onProviderChange: (provider: AgentProvider) => void;
  idPrefix?: string;
  layout?: "fields" | "settings";
}) {
  const adapterProps = {
    id: `${idPrefix}harness-adapter`,
    value: adapter,
    onChange: (event: ChangeEvent<HTMLSelectElement>) => onAdapterChange(event.currentTarget.value as HarnessAdapter),
  };
  const providerProps = {
    id: `${idPrefix}agent-provider`,
    value: provider,
    onChange: (event: ChangeEvent<HTMLSelectElement>) => onProviderChange(event.currentTarget.value as AgentProvider),
  };
  const adapterOptions = <>
    <option value="acp" disabled={!supportedAdapters.includes("acp")}>ACP</option>
    <option value="copilot" disabled={!supportedAdapters.includes("copilot")}>GitHub Copilot</option>
    <option value="codex" disabled={!supportedAdapters.includes("codex")}>Codex</option>
    <option value="opencode2" disabled={!supportedAdapters.includes("opencode2")}>OpenCode 2</option>
  </>;
  const providerOptions = AGENT_PROVIDER_OPTIONS.map((option) => (
    <option key={option.id} value={option.id}>{option.label}</option>
  ));
  return (
    <>
      {layout === "settings"
        ? <SettingsFieldRow title="Adapter" labelFor={adapterProps.id} content={<Select {...adapterProps} fieldWidth="normal">{adapterOptions}</Select>} />
        : <SelectField {...adapterProps} label="Adapter">{adapterOptions}</SelectField>}
      {adapter === "acp" && (
        layout === "settings"
          ? <SettingsFieldRow title="Harness preset" labelFor={providerProps.id} content={<Select {...providerProps} fieldWidth="normal">{providerOptions}</Select>} />
          : <SelectField {...providerProps} label="Harness preset">{providerOptions}</SelectField>
      )}
    </>
  );
}
