import { Fragment, useState, type FormEvent } from "react";
import {
  CheckboxField, CodeValue, ConfirmModal, DataList, DataListRow, EmptyState, ErrorState,
  FormActions, FormGroup, LoadingState, Modal, TextField, useLiveQuery, useToast,
} from "@pablozaiden/webapp/web";
import type { Workspace } from "@/shared/workspace";
import type { CollaborationGuestAccess, CollaborationInvitation, CollaborationWorkspacePermission, CollaborationWorkspacePermissions, WorkspaceConnectionStatus } from "@/shared/collaboration";
import { decodeCollaborationResourceReference } from "@/shared/collaboration-reference";
import { apiRequest } from "../../lib/api-client";
import { Button, StatusBadge } from "../common";
import { SettingsSelect } from "./settings-row-controls";
import { isBrowserCollaborationClient } from "../../client-sdk/browser-runtime";
import { BrowserCollaborationContent, BrowserConnectionsNotice } from "./browser-collaboration-content";
import { controllerStatusLabel, isControllerUnavailable } from "./collaboration-connection-status";

interface SharingState {
  connections: WorkspaceConnectionStatus[];
  guests: CollaborationGuestAccess[];
  invitations: CollaborationInvitation[];
  relays: Array<{ name: string; connected: boolean }>;
}

async function loadSharing(signal: AbortSignal): Promise<SharingState> {
  const [connections, guests, invitations, relays] = await Promise.all([
    apiRequest<SharingState["connections"]>("/api/collaboration/connections", { signal }),
    apiRequest<SharingState["guests"]>("/api/collaboration/guests", { signal }),
    apiRequest<SharingState["invitations"]>("/api/collaboration/invitations", { signal }),
    apiRequest<SharingState["relays"]>("/api/collaboration/relays", { signal }),
  ]);
  return { connections, guests, invitations, relays };
}

export function WorkspaceCollaborationContent({ workspaces }: { workspaces: Workspace[] }) {
  return isBrowserCollaborationClient()
    ? <BrowserCollaborationContent />
    : <ApiWorkspaceCollaborationContent workspaces={workspaces} />;
}

function ApiWorkspaceCollaborationContent({ workspaces }: { workspaces: Workspace[] }) {
  const toast = useToast();
  const query = useLiveQuery({
    load: loadSharing, realtime: { resources: ["workspace-connections", "workspace-collaboration", "mesh", "workspaces"] },
  });
  const [dialog, setDialog] = useState<"invite" | "connect" | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [allWorkspacesAdmin, setAllWorkspacesAdmin] = useState(false);
  const [permissions, setPermissions] = useState<CollaborationWorkspacePermissions>({});
  const [relayName, setRelayName] = useState("");
  const [name, setName] = useState("");
  const [invitation, setInvitation] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ path: string; title: string; message: string } | null>(null);
  const owned = workspaces.filter((workspace) => !decodeCollaborationResourceReference(workspace.id));
  const state = query.data;
  function close(): void {
    if (saving) return;
    setDialog(null);
    setToken("");
    setInvitation("");
    setSelected([]);
    setAllWorkspacesAdmin(false);
    setPermissions({});
    setName("");
    setError(null);
  }
  async function mutate(path: string, method: string, body?: unknown): Promise<unknown> {
    const value = await query.mutate(async (signal) => {
      const result = await apiRequest<unknown>(path, {
        signal, method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      return { result, state: await loadSharing(signal) };
    }, (_previous, value) => value.state);
    return value.result;
  }
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (dialog === "invite") {
        const result = await mutate("/api/collaboration/invitations", "POST", {
          allWorkspacesAdmin,
          workspaceIds: allWorkspacesAdmin ? [] : selected,
          workspacePermissions: allWorkspacesAdmin ? {} : Object.fromEntries(selected.map((id) => [id, permissions[id] ?? "work"])),
          relayName, ...(name.trim() ? { name: name.trim() } : {}),
        });
        if (!result || typeof result !== "object" || !("token" in result) || typeof result.token !== "string") {
          throw new Error("The invitation response is invalid.");
        }
        setToken(result.token);
      } else {
        await mutate("/api/collaboration/connections", "POST", {
          invitation: invitation.trim(), ...(name.trim() ? { name: name.trim() } : {}),
        });
        setDialog(null);
        setInvitation("");
        setName("");
        toast.success("Controller connected.");
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  }
  async function remove(): Promise<void> {
    if (!confirmation) return;
    setSaving(true);
    setError(null);
    try {
      await mutate(confirmation.path, "DELETE");
      setConfirmation(null);
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  }
  async function recover(id: string): Promise<void> {
    setSaving(true);
    try {
      await mutate(`/api/collaboration/connections/${encodeURIComponent(id)}/recover`, "POST");
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  }
  async function changePermission(guestId: string, workspaceId: string, permission: CollaborationWorkspacePermission): Promise<void> {
    setSaving(true);
    try {
      await mutate(`/api/collaboration/guests/${encodeURIComponent(guestId)}/workspaces/${encodeURIComponent(workspaceId)}`,
        "PUT", { permission });
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  }
  const workspaceName = (id: string): string => workspaces.find((workspace) => workspace.id === id)?.name ?? "Workspace unavailable";
  return (
    <div className="space-y-4">
      <FormActions>
        <Button disabled={saving} onClick={() => { setError(null); setDialog("connect"); }}>Connect controller</Button>
        <Button disabled={saving || !state?.relays.length} onClick={() => {
          setError(null);
          setRelayName(state?.relays[0]?.name ?? "");
          setDialog("invite");
        }}>Invite collaborator</Button>
      </FormActions>
      {query.error ? <ErrorState title="Sharing unavailable" description={String(query.error)} /> : null}
      {!state && query.loading ? <LoadingState title="Loading collaboration" /> : null}
      <h3 className="font-medium">Connected controllers</h3>
      {state?.connections.length === 0 ? <EmptyState title="No connected controllers" /> : null}
      <DataList>
        {state?.connections.map((entry) => {
          const { connection } = entry;
          const status = controllerStatusLabel(entry);
          return (
          <DataListRow key={connection.id} title={connection.name ?? "Shared controller"}
            badge={<StatusBadge variant={status === "Connected" ? "success" : "warning"}>{status}</StatusBadge>}
            actions={<>
              {connection.status !== "revoked" ? <Button size="sm" disabled={saving} onClick={() => void recover(connection.id)}>Reconnect</Button> : null}
              <Button size="sm" variant="danger" disabled={saving} onClick={() => setConfirmation({
                path: `/api/collaboration/connections/${encodeURIComponent(connection.id)}`,
                title: "Disconnect controller", message: "Remote tasks, chats and agent schedules will continue on the controller.",
              })}>Disconnect</Button>
            </>} />
        ); })}
      </DataList>
      <h3 className="font-medium">Collaborators</h3>
      {state && !state.guests.some((guest) => !guest.revokedAt) ? <EmptyState title="No collaborators" /> : null}
      <DataList>
        {state?.guests.filter((guest) => !guest.revokedAt).map((guest) => (
          <Fragment key={guest.id}>
            <DataListRow title={guest.name ?? "Collaborator"}
              description={guest.allWorkspacesAdmin ? "Administrator of all current and future workspaces" : undefined}
              actions={<Button variant="danger" size="sm" disabled={saving} onClick={() => setConfirmation({
                path: `/api/collaboration/guests/${encodeURIComponent(guest.id)}`,
                title: "Revoke collaborator", message: "This revokes all workspace access and closes the collaborator's terminals and previews. Admitted work continues.",
              })}>Revoke</Button>} />
            {!guest.allWorkspacesAdmin && guest.workspaceIds.map((id) => (
              <DataListRow key={id} title={workspaceName(id)} actions={<FormActions>
                <div className="w-fit shrink-0 whitespace-nowrap">
                  <CheckboxField label="Read only" aria-label={`Read only access to ${workspaceName(id)}`}
                    checked={guest.workspacePermissions[id] === "read"} disabled={saving}
                    onChange={(event) => void changePermission(guest.id, id, event.currentTarget.checked ? "read" : "work")} />
                </div>
                <Button size="sm" variant="danger" disabled={saving} aria-label={`Revoke access to ${workspaceName(id)}`} onClick={() => setConfirmation({
                  path: `/api/collaboration/guests/${encodeURIComponent(guest.id)}/workspaces/${encodeURIComponent(id)}`,
                  title: `Revoke ${workspaceName(id)}`, message: "This closes the collaborator's terminals and previews in this workspace. Admitted work continues.",
                })}>Revoke</Button>
              </FormActions>} />
            ))}
          </Fragment>
        ))}
        {state?.invitations.filter((entry) => !entry.consumedAt && !entry.revokedAt && Date.parse(entry.expiresAt) > Date.now()).map((entry) => (
          <DataListRow key={entry.id} title={entry.name ?? "Workspace invitation"}
            meta={`Expires ${new Date(entry.expiresAt).toLocaleString()}`}
            metaPlacement="below"
            description={entry.allWorkspacesAdmin ? "Administrator of all current and future workspaces"
              : entry.workspaceIds.map((id) => `${workspaceName(id)} (${entry.workspacePermissions[id] === "read" ? "Read only" : "Work"})`).join(", ")}
            actions={<Button variant="danger" size="sm" disabled={saving} onClick={() => setConfirmation({
              path: `/api/collaboration/invitations/${encodeURIComponent(entry.id)}`,
              title: "Revoke invitation", message: "The unused invitation will no longer allow pairing.",
            })}>Revoke invitation</Button>} />
        ))}
      </DataList>
      <Modal isOpen={dialog !== null} onClose={close} title={dialog === "invite" ? "Invite collaborator" : "Connect controller"}>
        {token ? <>
          <CodeValue label="One-use invitation" value={token} />
          <FormActions><Button onClick={close}>Close</Button></FormActions>
        </> : <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <TextField label={dialog === "invite" ? "Invitation name" : "Controller name"} value={name} maxLength={120} onChange={(event) => setName(event.currentTarget.value)} disabled={saving} />
          {dialog === "invite" ? <>
            <CheckboxField label="All workspaces" checked={allWorkspacesAdmin}
              disabled={saving} onChange={(event) => setAllWorkspacesAdmin(event.currentTarget.checked)} />
            {!allWorkspacesAdmin && <FormGroup title="Workspaces">
              {owned.map((workspace) => <div key={workspace.id} className="flex items-center justify-between gap-3">
                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <input type="checkbox" checked={selected.includes(workspace.id)} disabled={saving} onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setSelected((ids) => checked ? [...ids, workspace.id] : ids.filter((id) => id !== workspace.id));
                  }} />
                  <span>{workspace.name}</span>
                </label>
                <div className="w-fit shrink-0 whitespace-nowrap">
                  <CheckboxField label="Read only" aria-label={`Read only access to ${workspace.name}`}
                    checked={permissions[workspace.id] === "read"}
                    disabled={saving || !selected.includes(workspace.id)} onChange={(event) => {
                      const permission = event.currentTarget.checked ? "read" : "work";
                      setPermissions((current) => ({ ...current, [workspace.id]: permission }));
                    }} />
                </div>
              </div>)}
            </FormGroup>}
            <label className="block space-y-1"><span>Relay</span>
              <SettingsSelect value={relayName} required disabled={saving} onChange={(event) => setRelayName(event.currentTarget.value)}>
                {state?.relays.map((relay) => <option key={relay.name} value={relay.name}>{relay.name}{relay.connected ? "" : " (disconnected)"}</option>)}
              </SettingsSelect>
            </label>
          </> : <TextField label="Invitation token" required value={invitation} onChange={(event) => setInvitation(event.currentTarget.value)} disabled={saving} />}
          {error ? <ErrorState title="Unable to complete pairing" description={error} /> : null}
          <FormActions>
            <Button disabled={saving} onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" loading={saving} disabled={dialog === "invite" && (!allWorkspacesAdmin && !selected.length || !relayName)}>
              {dialog === "invite" ? "Create invitation" : "Connect"}
            </Button>
          </FormActions>
        </form>}
      </Modal>
      <ConfirmModal isOpen={confirmation !== null} title={confirmation?.title ?? "Confirm"}
        message={confirmation?.message ?? ""} confirmLabel="Confirm" variant="danger" loading={saving}
        onClose={() => { if (!saving) setConfirmation(null); }} onConfirm={remove} />
    </div>
  );
}

export function WorkspaceConnectionsNotice() {
  return isBrowserCollaborationClient() ? <BrowserConnectionsNotice /> : <ApiConnectionsNotice />;
}

function ApiConnectionsNotice() {
  const query = useLiveQuery<WorkspaceConnectionStatus[]>({
    load: (signal) => apiRequest("/api/collaboration/connections", { signal }),
    realtime: { resources: ["workspace-connections"] },
  });
  const unavailable = query.data?.filter(isControllerUnavailable);
  if (query.error) return <ErrorState title="Controller connection status unavailable" description={String(query.error)} />;
  if (!unavailable?.length) return null;
  return <ErrorState title="Some shared workspaces are unavailable"
    description={`${unavailable.map((entry) => entry.connection.name ?? "Shared controller").join(", ")}. Results are incomplete. Reconnect in Settings > Collaboration.`} />;
}
