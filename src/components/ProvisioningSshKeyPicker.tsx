import { EmptyState, LoadingState, SettingsFieldRow } from "@pablozaiden/webapp/web";
import { useSshKeyInventory } from "../hooks/useSshKeyInventory";
import { SettingsCheckbox, SettingsError } from "./app-settings/settings-row-controls";

export interface ProvisioningSshKeyPickerProps {
  keyIds: readonly string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

export function ProvisioningSshKeyPicker({
  keyIds,
  onChange,
  disabled = false,
}: ProvisioningSshKeyPickerProps) {
  const query = useSshKeyInventory();
  if (!query.data && query.loading) return <LoadingState title="Loading SSH keys" />;
  return <div className="space-y-3">
    {query.error ? <SettingsError>{String(query.error)}</SettingsError> : null}
    {query.data?.keys.length === 0 ? <EmptyState title="No registered SSH-agent keys" /> : null}
    {query.data?.keys.map((key) => {
      const keyName = key.alias.trim() || key.comment.trim() || "Unnamed SSH key";
      const source = query.data?.sources.find((candidate) => candidate.id === key.sourceId);
      return <SettingsFieldRow
        key={key.id}
        title={keyName}
        description={source ? source.name.trim() || "Unnamed SSH-agent source" : "Unavailable source"}
        content={<SettingsCheckbox
          ariaLabel={`Use ${keyName} for the initial SSH clone`}
          checked={keyIds.includes(key.id)}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked
            ? [...keyIds, key.id]
            : keyIds.filter((id) => id !== key.id))}
        />}
      />;
    })}
  </div>;
}
