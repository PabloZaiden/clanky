import { SelectField } from "@pablozaiden/webapp/web";
import type { ControlGrantSelection } from "@/contracts/schemas/control";

export interface ControlConsentOptions {
  workspaces: Array<{ id: string; name: string }>;
  generalAllowed: boolean;
}

export function ControlGrantFields({ options, value, onChange, disabled, idPrefix }: {
  options: ControlConsentOptions;
  value: ControlGrantSelection | null;
  onChange: (value: ControlGrantSelection | null) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  return <>
    <SelectField id={`${idPrefix}-level`} label="Access" required value={value?.level ?? ""}
      disabled={disabled} onChange={(event) => {
        const level = event.currentTarget.value;
        onChange(level === "general" ? { level: "general" }
          : level === "workspace" ? { level: "workspace", workspaceId: "" } : null);
      }}>
      <option value="">Choose access</option>
      <option value="workspace" disabled={!options.workspaces.length}>One workspace</option>
      {options.generalAllowed ? <option value="general">General access</option> : null}
    </SelectField>
    {value?.level === "workspace" ? (
      <SelectField id={`${idPrefix}-workspace`} label="Workspace" required value={value.workspaceId}
        disabled={disabled} onChange={(event) => onChange({ level: "workspace", workspaceId: event.currentTarget.value })}>
        <option value="">Choose workspace</option>
        {options.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
      </SelectField>
    ) : null}
    <p className="text-sm text-gray-600 dark:text-gray-400">
      {value?.level === "general"
        ? "Cross-project control and administration within your permissions. This does not grant owner or admin status; destructive actions still need human approval."
        : "Project collaboration is limited to the selected workspace. It does not allow workspace or server administration."}
    </p>
  </>;
}
