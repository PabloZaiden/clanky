import type { ChangeEvent } from "react";
import { Select, SelectField, SettingsFieldRow } from "@pablozaiden/webapp/web";
import type { HarnessAdapter } from "@/shared";

export function HarnessRuntimeSelector({ adapter, supportedAdapters, onAdapterChange, idPrefix = "", layout = "fields" }: {
  adapter: HarnessAdapter;
  supportedAdapters: readonly HarnessAdapter[];
  onAdapterChange: (adapter: HarnessAdapter) => void;
  idPrefix?: string;
  layout?: "fields" | "settings";
}) {
  const adapterProps = {
    id: `${idPrefix}harness-adapter`,
    value: adapter,
    onChange: (event: ChangeEvent<HTMLSelectElement>) => onAdapterChange(event.currentTarget.value as HarnessAdapter),
  };
  const adapterOptions = <>
    <option value="copilot" disabled={!supportedAdapters.includes("copilot")}>GitHub Copilot</option>
    <option value="codex" disabled={!supportedAdapters.includes("codex")}>Codex</option>
    <option value="opencode2" disabled={!supportedAdapters.includes("opencode2")}>OpenCode 2</option>
  </>;
  return (
    <>
      {layout === "settings"
        ? <SettingsFieldRow title="Adapter" labelFor={adapterProps.id} content={<Select {...adapterProps} fieldWidth="normal">{adapterOptions}</Select>} />
        : <SelectField {...adapterProps} label="Adapter">{adapterOptions}</SelectField>}
    </>
  );
}
