import { useState, type FormEvent } from "react";
import {
  CodeValue, ConfirmModal, DataList, DataListRow, EmptyState, ErrorState,
  FormActions, FormGroup, LoadingState, Modal, TextField, useLiveQuery, useToast,
} from "@pablozaiden/webapp/web";
import type { ControlCredentialSummary, ControlGrantSelection } from "@/contracts/schemas/control";
import { apiRequest } from "../../lib/api-client";
import { Button } from "../common";
import { ControlGrantFields, type ControlConsentOptions } from "../control/control-grant-fields";

async function loadCredentials(signal: AbortSignal) {
  const [credentials, options] = await Promise.all([
    apiRequest<ControlCredentialSummary[]>("/api/control/credentials", { signal }),
    apiRequest<ControlConsentOptions>("/api/control/consent-options", { signal }),
  ]);
  return { credentials, options };
}

export function ControlCredentialsContent() {
  const { success } = useToast();
  const query = useLiveQuery({ load: loadCredentials, realtime: { resources: ["control-credentials"] } });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [grant, setGrant] = useState<ControlGrantSelection | null>(null);
  const [expiresInDays, setExpiresInDays] = useState("30");
  const [created, setCreated] = useState<{ credential: ControlCredentialSummary; token: string } | null>(null);
  const [revoke, setRevoke] = useState<ControlCredentialSummary | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = query.data;

  function close(): void {
    if (saving) return;
    setCreating(false);
    setCreated(null);
    setName("");
    setGrant(null);
    setExpiresInDays("30");
    setError(null);
  }
  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!grant || saving) return;
    setSaving(true);
    setError(null);
    try {
      await query.mutate(async (signal) => {
        const result = await apiRequest<{ credential: ControlCredentialSummary; token: string }>("/api/control/credentials", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), grant, expiresInDays: Number(expiresInDays) }), signal,
          action: "Create control service credential",
        });
        if (!signal.aborted) {
          setCreated(result);
          success("Service credential created.");
        }
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setSaving(false); }
  }
  async function revokeCredential(): Promise<void> {
    if (!revoke || saving) return;
    setSaving(true);
    setError(null);
    try {
      await query.mutate((signal) => apiRequest<{ revoked: true }>(`/api/control/credentials/${encodeURIComponent(revoke.id)}`, {
        method: "DELETE", signal, action: "Revoke control service credential",
      }));
      setRevoke(null);
      success("Service credential revoked.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setSaving(false); }
  }

  return <div className="space-y-4">
    <FormActions><Button disabled={!query.data || saving} onClick={() => { setError(null); setCreating(true); }}>
      Create service credential
    </Button></FormActions>
    {!query.data && query.loading ? <LoadingState title="Loading service credentials" /> : null}
    {query.error && !creating && !revoke ? <ErrorState title="Service credentials unavailable" description={String(query.error)}
      action={<Button onClick={() => void query.refresh()}>Retry</Button>} /> : null}
    {query.data?.credentials.length === 0 ? <EmptyState title="No service credentials" /> : null}
    <DataList>
      {state?.credentials.map((credential) => <DataListRow key={credential.id} title={credential.name}
        description={credential.grant.level === "general" ? "General access"
          : `Workspace: ${workspaceName(credential, state.options)}`}
        meta={`Expires ${new Date(credential.expiresAt).toLocaleString()}`} metaPlacement="below"
        actions={<Button variant="danger" disabled={saving} onClick={() => { setError(null); setRevoke(credential); }}>Revoke</Button>} />)}
    </DataList>
    <Modal isOpen={creating} onClose={close} title={created ? "Save your service credential" : "Create service credential"}
      description={created ? "Shown only once. Copy it now and store it securely. Closing this dialog removes it from this page." : undefined}
      size="md" showCloseButton={!saving} closeOnOverlayClick={!saving}>
      {created ? <>
        <CodeValue label={created.credential.name} value={created.token} copyLabel="Copy token" />
        <FormActions><Button onClick={close}>Done</Button></FormActions>
      </> : <form className="space-y-4" onSubmit={(event) => void create(event)}>
        <TextField id="control-credential-name" label="Name" required maxLength={100} value={name}
          disabled={saving} onChange={(event) => setName(event.currentTarget.value)} />
        {query.data ? <FormGroup title="Allowed access">
          <ControlGrantFields options={query.data.options} value={grant} onChange={setGrant}
            idPrefix="control-credential" disabled={saving} />
        </FormGroup> : null}
        <TextField id="control-credential-expiry" label="Expires in days" type="number" min={1} max={90} step={1}
          required value={expiresInDays} disabled={saving} onChange={(event) => setExpiresInDays(event.currentTarget.value)} />
        {error ? <ErrorState title="Credential not created" description={error} /> : null}
        <FormActions>
          <Button disabled={saving} onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={saving}
            disabled={!name.trim() || !grant || grant.level === "workspace" && !grant.workspaceId}>Create</Button>
        </FormActions>
      </form>}
    </Modal>
    <ConfirmModal isOpen={revoke !== null} title="Revoke service credential?"
      message={`Revoke “${revoke?.name ?? ""}”? Subsequent control requests using this credential will be denied.`}
      confirmLabel="Revoke" variant="danger" loading={saving}
      onClose={() => { if (!saving) { setRevoke(null); setError(null); } }} onConfirm={() => void revokeCredential()}>
      {error ? <ErrorState title="Credential not revoked" description={error} /> : null}
    </ConfirmModal>
  </div>;
}

function workspaceName(credential: ControlCredentialSummary, options: ControlConsentOptions): string {
  const grant = credential.grant;
  return grant.level === "workspace"
    ? options.workspaces.find((workspace) => workspace.id === grant.workspaceId)?.name ?? "Workspace unavailable"
    : "General access";
}
