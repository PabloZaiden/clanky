import { useState } from "react";
import { createLogger, EmptyState, ErrorState, LoadingState, useLiveQuery, useWebAppConfig } from "@pablozaiden/webapp/web";
import type { ControlApprovalPolicy } from "@/contracts/schemas/control";
import { apiRequest } from "../../lib/api-client";
import { Button } from "../common";
import { SettingsCheckbox, SettingsError } from "./settings-row-controls";

const log = createLogger("control-approval-policy");

export function ControlApprovalPolicyContent() {
  const { config } = useWebAppConfig();
  const available = config?.passkeyAuth.enabled === true
    && config.passkeyAuth.authenticated && !config.passkeyAuth.passkeyDisabled;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const query = useLiveQuery({
    enabled: available,
    load: (signal) => apiRequest<ControlApprovalPolicy>("/api/control/approval-policy", { signal }),
    realtime: { resources: ["control-requests"], scopes: ["policy"] },
  });
  async function save(requireApproval: boolean) {
    setSaving(true);
    setSaveError(null);
    try {
      await query.mutate((signal) => apiRequest<ControlApprovalPolicy>("/api/control/approval-policy", {
        signal, method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireApproval }),
      }), (_previous, saved) => saved);
    } catch (error) {
      log.error("Could not save control approval policy", { error: String(error) });
      setSaveError(String(error));
    } finally { setSaving(false); }
  }
  if (!available) return <EmptyState title="Passkey sign-in required" />;
  if (query.error) return <ErrorState title={saveError ? "Could not save approval policy" : "Could not load approval policy"}
    description={saveError ?? String(query.error)}
    action={<Button disabled={query.loading} onClick={() => {
      setSaveError(null);
      void query.refresh();
    }}>Retry</Button>} />;
  if (!query.data) return <LoadingState title="Loading approval policy" />;
  return <>
    <SettingsCheckbox id="require-control-approval" ariaLabel="Require approval for agent operations"
      checked={query.data.requireApproval} disabled={saving || query.loading}
      onChange={(event) => void save(event.currentTarget.checked)} />
    {saving ? <span role="status">Saving...</span> : null}
    {saveError ? <SettingsError>{saveError}</SettingsError> : null}
  </>;
}
