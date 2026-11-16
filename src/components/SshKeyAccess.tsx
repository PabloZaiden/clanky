import { useState } from "react";
import { EmptyState, LoadingState, SettingsFieldRow } from "@pablozaiden/webapp/web";
import { useSshKeyAccess } from "../hooks/useSshKeyAccess";
import { SettingsCheckbox, SettingsError } from "./app-settings/settings-row-controls";

export function SshKeyAccess({ path, contextLabel, disabled = false }: { path: string; contextLabel: string; disabled?: boolean }) {
  const query = useSshKeyAccess(path);
  const [error, setError] = useState<string | null>(null);
  if (!query.data && query.loading) return <LoadingState title="Loading SSH-key access" />;
  return <div className="space-y-3">
    {query.error || error ? <SettingsError>{error ?? String(query.error)}</SettingsError> : null}
    {query.data?.keys.length === 0 ? <EmptyState title="No registered SSH-agent keys" /> : null}
    {query.data?.keys.map((key) => {
      const keyName = key.alias.trim() || key.comment.trim() || "Unnamed SSH key";
      const source = query.data?.sources.find((candidate) => candidate.id === key.sourceId);
      return <SettingsFieldRow
        key={key.id}
        title={keyName}
        description={source ? source.name.trim() || "Unnamed SSH-agent source" : "Unavailable source"}
        content={<SettingsCheckbox
          ariaLabel={`Allow ${keyName} in this ${contextLabel}`}
          checked={query.data?.grants.some((grant) => grant.keyId === key.id && grant.enabled) ?? false}
          disabled={disabled || query.saving}
          onChange={(event) => {
            setError(null);
            void query.setGrant(key.id, event.target.checked).catch((failure) => setError(failure instanceof Error ? failure.message : "Failed to update SSH-key access."));
          }}
        />}
      />;
    })}
  </div>;
}
