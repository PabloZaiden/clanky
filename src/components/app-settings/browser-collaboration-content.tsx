import { useState, useSyncExternalStore, type FormEvent } from "react";
import {
  ConfirmModal, DataList, DataListRow, EmptyState, ErrorState,
  FormActions, LoadingState, Modal, Panel, TextField, routeToHash, useToast,
} from "@pablozaiden/webapp/web";
import type { WorkspaceConnectionStatus } from "@/shared/collaboration";
import { CollaborationNameSchema } from "@/contracts/schemas/collaboration";
import { browserPreferences } from "../../client-sdk/browser-preferences";
import { getBrowserCollaborationClient } from "../../client-sdk/browser-runtime";
import { Button, StatusBadge } from "../common";
import { controllerStatusLabel, isControllerUnavailable } from "./collaboration-connection-status";

function useBrowserConnections() {
  const client = getBrowserCollaborationClient()!;
  return { client, state: useSyncExternalStore(client.connections.subscribe, client.connections.getSnapshot) };
}

export function BrowserCollaborationContent() {
  const { client, state } = useBrowserConnections();
  const toast = useToast();
  const [dialog, setDialog] = useState<{ kind: "connect" } | { kind: "recover"; id: string } | null>(null);
  const [name, setName] = useState("");
  const [guestName, setGuestName] = useState("");
  const [invitation, setInvitation] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<WorkspaceConnectionStatus | null>(null);

  function open(next: NonNullable<typeof dialog>): void {
    setError(null);
    setName("");
    setInvitation("");
    setDialog(next);
    try {
      setGuestName(browserPreferences.collaborationName.read() ?? "");
    } catch (failure) {
      setGuestName("");
      setError(String(failure));
    }
  }
  function close(): void {
    if (saving) return;
    setDialog(null);
    setInvitation("");
    setError(null);
  }
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!dialog || saving) return;
    setSaving(true);
    setError(null);
    try {
      const guest = CollaborationNameSchema.parse(guestName);
      browserPreferences.collaborationName.write(guest);
      if (dialog.kind === "recover") {
        await client.recover(dialog.id, guest);
      } else {
        await client.accept({
          invitation: invitation.trim(), guestName: guest,
          ...(name.trim() ? { name: CollaborationNameSchema.parse(name) } : {}),
        });
      }
      setDialog(null);
      setInvitation("");
      toast.success("Controller connected.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  }
  async function recover(id: string): Promise<void> {
    setSaving(true);
    try {
      const guest = browserPreferences.collaborationName.read();
      if (guest === null) {
        open({ kind: "recover", id });
        return;
      }
      await client.recover(id, guest);
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  }
  async function forget(): Promise<void> {
    if (!confirmation || saving) return;
    setSaving(true);
    try {
      await client.forget(confirmation.connection.id);
      setConfirmation(null);
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  }
  return <div className="space-y-4">
    <FormActions>
      <Button disabled={saving} onClick={() => open({ kind: "connect" })}>Connect controller</Button>
    </FormActions>
    {state.error ? <ErrorState title="Connections unavailable" description={state.error.message} /> : null}
    {state.loading ? <LoadingState title="Loading connections" /> : null}
    {!state.loading && !state.error && state.connections.length === 0 ? <EmptyState title="No connected controllers" /> : null}
    <DataList>
      {state.connections.map((entry) => {
        const { connection } = entry;
        const inUse = entry.errorCode === "collaboration_connection_in_use";
        const label = controllerStatusLabel(entry);
        return <DataListRow key={connection.id} title={connection.name ?? "Shared controller"}
          badge={<StatusBadge variant={label === "Connected" ? "success" : "warning"}>{label}</StatusBadge>}
          description={inUse ? "Close the other Clanky tab before reconnecting here." : undefined}
          actions={<>
            {connection.status !== "revoked" ? <Button size="sm" disabled={saving || inUse}
              onClick={() => void recover(connection.id)}>Reconnect</Button> : null}
            <Button size="sm" variant="danger" disabled={saving || inUse}
              onClick={() => setConfirmation(entry)}>Disconnect</Button>
          </>} />;
      })}
    </DataList>
    <Modal isOpen={dialog !== null} onClose={close} title={dialog?.kind === "recover" ? "Recover connection" : "Connect controller"}>
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <TextField label="Your name" required maxLength={120} value={guestName}
          onChange={(event) => setGuestName(event.currentTarget.value)} disabled={saving} />
        {dialog?.kind === "connect" ? <>
          <TextField label="Controller name" maxLength={120} value={name}
            onChange={(event) => setName(event.currentTarget.value)} disabled={saving} />
          <TextField label="Invitation token" required value={invitation}
            onChange={(event) => setInvitation(event.currentTarget.value)} disabled={saving} />
        </> : null}
        {error ? <ErrorState title="Unable to complete pairing" description={error} /> : null}
        <FormActions>
          <Button disabled={saving} onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={saving}>
            {dialog?.kind === "recover" ? "Recover" : "Connect"}
          </Button>
        </FormActions>
      </form>
    </Modal>
    <ConfirmModal isOpen={confirmation !== null} title="Disconnect controller"
      message="This removes the saved pairing from this browser profile. A new invitation will be needed to reconnect. Remote work continues."
      confirmLabel="Disconnect" variant="danger" loading={saving}
      onClose={() => { if (!saving) setConfirmation(null); }} onConfirm={forget} />
  </div>;
}

export function BrowserConnectionsNotice() {
  const { state } = useBrowserConnections();
  if (state.error) return <ErrorState title="Controller connection status unavailable" description={state.error.message} />;
  if (state.loading) return <LoadingState title="Loading connections" />;
  const link = <a href={routeToHash({ view: "settings", category: "collaboration" })}>Connect controller</a>;
  if (state.connections.length === 0) {
    return <Panel title="No connected controllers"><FormActions>{link}</FormActions></Panel>;
  }
  const unavailable = state.connections.filter((entry) => entry.connection.status !== "active" || isControllerUnavailable(entry));
  if (unavailable.length === 0) return null;
  return <ErrorState title="Some shared workspaces are unavailable"
    description={`${unavailable.map((entry) => `${entry.connection.name ?? "Shared controller"}: ${controllerStatusLabel(entry)}`).join(", ")}. Reconnect in Settings > Collaboration.`} />;
}
