import { useState, type FormEvent } from "react";
import { Button, ConfirmModal, EmptyState, FormActions, FormGroup, LoadingState, SettingsFieldRow, TextField } from "@pablozaiden/webapp/web";
import type { SshAgentIdentity, SshKeySource } from "@/shared/ssh-key-access";
import { useExecutionHosts } from "../../hooks/useExecutionHosts";
import { useSshKeyInventory } from "../../hooks/useSshKeyInventory";
import { apiRequest } from "../../lib/api-client";
import { SettingsError, SettingsInput, SettingsSelect } from "./settings-row-controls";

export function SshKeySourcesContent() {
  const hosts = useExecutionHosts();
  const query = useSshKeyInventory();
  const [hostIndex, setHostIndex] = useState("");
  const [name, setName] = useState("");
  const [discovered, setDiscovered] = useState<{ sourceId: string; identities: SshAgentIdentity[] } | null>(null);
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<SshKeySource | null>(null);
  async function perform(action: () => Promise<void>) {
    setSaving(true);
    setError(null);
    try { await action(); await query.refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The SSH-agent operation failed."); }
    finally { setSaving(false); }
  }
  async function register(event: FormEvent) {
    event.preventDefault();
    const host = hosts.hosts[Number(hostIndex)];
    if (!host || hostIndex === "") return;
    await perform(async () => {
      const source = await apiRequest<SshKeySource>("/api/ssh-key-access/sources", {
        method: "POST", body: JSON.stringify({ name, host: host.ref }), headers: { "Content-Type": "application/json" },
        action: "Authorize SSH-agent source", fallbackMessage: "Failed to authorize SSH-agent source",
      });
      setName("");
      setDiscovered({ sourceId: source.id, ...(await apiRequest<{ identities: SshAgentIdentity[] }>(
        `/api/ssh-key-access/sources/${source.id}/identities`,
        { action: "Discover SSH-agent keys", fallbackMessage: "Failed to discover SSH-agent keys" },
      )) });
    });
  }
  return <div className="space-y-4">
    {error || query.error ? <SettingsError>{error ?? String(query.error)}</SettingsError> : null}
    {!query.data && query.loading ? <LoadingState title="Loading SSH-key sources" /> : null}
    <form onSubmit={(event) => { void register(event); }}>
      <SettingsFieldRow title="Agent source" content={<div className="flex flex-wrap gap-2">
        <SettingsSelect aria-label="SSH-agent custodian" value={hostIndex} onChange={(event) => setHostIndex(event.target.value)} required disabled={saving}>
          <option value="">Select a custodian host</option>
          {hosts.hosts.map((host, index) => <option key={index} value={index}>{host.name.trim() || "Unnamed custodian host"}</option>)}
        </SettingsSelect>
        <SettingsInput aria-label="SSH-agent source name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Source name" required maxLength={100} disabled={saving} />
      </div>} actions={<Button type="submit" disabled={saving || !name.trim() || hostIndex === ""}>Authorize source</Button>} />
    </form>
    <FormGroup>
      {query.data?.sources.map((source) => <SettingsFieldRow key={source.id} title={source.name.trim() || "Unnamed SSH-agent source"}
        description={`${query.data?.keys.filter((key) => key.sourceId === source.id).length ?? 0} registered keys`}
        actions={<><Button disabled={saving} onClick={() => { void perform(async () => {
          const result = await apiRequest<{ identities: SshAgentIdentity[] }>(`/api/ssh-key-access/sources/${source.id}/identities`,
            { action: "Discover SSH-agent keys", fallbackMessage: "Failed to discover SSH-agent keys" });
          setDiscovered({ sourceId: source.id, ...result });
        }); }}>Discover keys</Button><Button disabled={saving} onClick={() => setRemoving(source)}>Remove source</Button></>} />)}
    </FormGroup>
    {discovered?.identities.length === 0 ? <EmptyState title="No keys loaded in this agent" /> : null}
    {discovered?.identities.map((identity) => {
      const registered = query.data?.keys.find((key) => key.sourceId === discovered.sourceId && key.publicKey === identity.publicKey);
      const defaultAlias = registered?.alias.trim() || identity.comment.trim().slice(0, 100);
      const keyName = defaultAlias || "Unnamed SSH key";
      return <form key={identity.fingerprint} onSubmit={(event) => {
        event.preventDefault();
        void perform(async () => {
          await apiRequest(`/api/ssh-key-access/sources/${discovered.sourceId}/keys`, {
            method: "POST", body: JSON.stringify({ publicKey: identity.publicKey, alias: aliases[identity.fingerprint]?.trim() || keyName }),
            headers: { "Content-Type": "application/json" },
            action: "Register SSH public key", fallbackMessage: "Failed to register SSH public key",
          });
        });
      }}>
        <FormGroup title={keyName}>
          <FormGroup layout="inline">
            <TextField label="Key alias" aria-label={`Alias for ${keyName}`}
              value={aliases[identity.fingerprint] ?? defaultAlias} maxLength={100} disabled={saving}
              onChange={(event) => setAliases((current) => ({ ...current, [identity.fingerprint]: event.target.value }))} placeholder="Key alias" />
            <FormActions><Button type="submit" disabled={saving}>Register key</Button></FormActions>
          </FormGroup>
        </FormGroup>
      </form>;
    })}
    <ConfirmModal isOpen={removing !== null} onClose={() => setRemoving(null)} title="Remove SSH-agent source"
      message={`Remove ${removing?.name.trim() || "this SSH-agent source"} and revoke all of its workspace key grants? Established SSH sessions are not terminated.`}
      confirmLabel="Remove source" variant="danger" loading={saving}
      onConfirm={() => { if (removing) void perform(async () => {
        await apiRequest(`/api/ssh-key-access/sources/${removing.id}`, {
          method: "DELETE", action: "Remove SSH-agent source", fallbackMessage: "Failed to remove SSH-agent source",
        });
        if (discovered?.sourceId === removing.id) setDiscovered(null);
        setRemoving(null);
      }); }} />
  </div>;
}
