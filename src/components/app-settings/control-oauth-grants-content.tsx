import { useState } from "react";
import {
  appJson, ConfirmModal, DataList, DataListRow, EmptyState, ErrorState,
  FormActions, LoadingState, useLiveQuery, useToast,
} from "@pablozaiden/webapp/web";
import { ControlGrantSelectionSchema } from "@/contracts/schemas/control";
import { apiRequest } from "../../lib/api-client";
import { Button } from "../common";
import type { ControlConsentOptions } from "../control/control-grant-fields";

interface OAuthGrantSummary {
  id: string;
  clientName: string;
  resource: string;
  scopes: string[];
  expiresAt: string;
  authorizationContext?: unknown;
}

async function loadGrants(signal: AbortSignal) {
  const [result, options] = await Promise.all([
    appJson<{ grants: OAuthGrantSummary[] }>("/api/oauth/grants", { signal }),
    apiRequest<ControlConsentOptions>("/api/control/consent-options", { signal }),
  ]);
  return { grants: result.grants, options };
}

function accessLabel(grant: OAuthGrantSummary, options: ControlConsentOptions): string {
  const selection = ControlGrantSelectionSchema.safeParse(grant.authorizationContext);
  if (!selection.success) return "Access details unavailable";
  if (selection.data.level === "general") return "General access";
  const workspaceId = selection.data.workspaceId;
  return `Workspace: ${options.workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? "Workspace unavailable"}`;
}

export function ControlOAuthGrantsContent() {
  const { success } = useToast();
  const query = useLiveQuery({ load: loadGrants, realtime: false });
  const [revoke, setRevoke] = useState<OAuthGrantSummary | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = query.data;

  async function revokeGrant(): Promise<void> {
    if (!revoke || saving) return;
    setSaving(true);
    setError(null);
    try {
      await query.mutate((signal) => appJson(`/api/oauth/grants?${new URLSearchParams({ id: revoke.id })}`, {
        method: "DELETE", signal,
      }));
      setRevoke(null);
      success("Integration access revoked.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setSaving(false); }
  }

  return <div className="space-y-4">
    <FormActions><Button disabled={saving || query.loading} onClick={() => void query.refresh()}>Refresh</Button></FormActions>
    {!state && query.loading ? <LoadingState title="Loading authorized integrations" /> : null}
    {query.error && !revoke ? <ErrorState title="Authorized integrations unavailable" description={String(query.error)} /> : null}
    {state?.grants.length === 0 ? <EmptyState title="No authorized integrations" /> : null}
    <DataList>
      {state?.grants.map((grant) => <DataListRow key={grant.id} title={grant.clientName}
        description={<>
          <span className="block">{accessLabel(grant, state.options)}</span>
          <span className="block break-words">Scope: {grant.scopes.join(", ")}</span>
          <span className="block break-all">{grant.resource}</span>
        </>}
        meta={`Expires ${new Date(grant.expiresAt).toLocaleString()}`} metaPlacement="below"
        actions={<Button variant="danger" disabled={saving} onClick={() => { setError(null); setRevoke(grant); }}>Revoke access</Button>} />)}
    </DataList>
    <ConfirmModal isOpen={revoke !== null} title="Revoke integration access?"
      message={`Revoke access for “${revoke?.clientName ?? ""}”? Its current access and refresh credentials will stop working.`}
      confirmLabel="Revoke access" variant="danger" loading={saving}
      onClose={() => { if (!saving) { setRevoke(null); setError(null); } }} onConfirm={() => void revokeGrant()}>
      {error ? <ErrorState title="Access not revoked" description={error} /> : null}
    </ConfirmModal>
  </div>;
}
