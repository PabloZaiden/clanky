import { useCallback, useId, useState, type FormEvent } from "react";
import type { PasswordStatusResponse } from "../../contracts";
import { Button, Modal, SettingsFieldRow, TextField, useLiveQuery } from "@pablozaiden/webapp/web";
import { appJson } from "../api-client";
import { ResourceState } from "./resource-state";

export function PasswordSection({ refresh }: { refresh: () => Promise<void> }) {
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const load = useCallback(() => appJson<PasswordStatusResponse>("/api/auth/password"), []);
  const status = useLiveQuery<PasswordStatusResponse>({ load, realtime: false });

  function close() {
    if (busy) return;
    setOpen(false);
    setCurrentPassword("");
    setNextPassword("");
    setError(undefined);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !status.data) return;
    setBusy(true);
    setError(undefined);
    try {
      await appJson<PasswordStatusResponse>("/api/auth/password", {
        method: status.data.configured ? "PUT" : "POST",
        body: JSON.stringify(status.data.configured
          ? { currentPassword, nextPassword }
          : { password: nextPassword }),
      });
      setCurrentPassword("");
      setNextPassword("");
      setOpen(false);
      await status.refresh();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <SettingsFieldRow
      title="Password"
      description={status.data ? status.data.configured ? "Configured" : "Not configured" : undefined}
      actions={<Button type="button" disabled={!status.data || status.loading || busy} onClick={() => setOpen(true)}>
        {status.data?.configured ? "Change password" : "Create password"}
      </Button>}
    />
    <ResourceState loading={status.loading} error={status.error} hasData={status.data !== undefined} refresh={status.refresh} />
    {!open && error ? <p className="wapp-error" role="alert">{error}</p> : null}
    <Modal
      isOpen={open}
      onClose={close}
      title={status.data?.configured ? "Change password" : "Create password"}
      footer={<>
        <Button type="button" disabled={busy} onClick={close}>Cancel</Button>
        <Button type="submit" form={formId} variant="primary" loading={busy}>Save password</Button>
      </>}
    >
      <form id={formId} onSubmit={(event) => void save(event)}>
        {status.data?.configured ? <TextField
          label="Current password" type="password" autoComplete="current-password" required maxLength={1024}
          disabled={busy} value={currentPassword} onChange={(event) => setCurrentPassword(event.currentTarget.value)}
        /> : null}
        <TextField
          label="New password" type="password" autoComplete="new-password" required minLength={12} maxLength={1024}
          disabled={busy} value={nextPassword} onChange={(event) => setNextPassword(event.currentTarget.value)}
        />
        <p className="wapp-muted">At least 12 characters and at most 1024 bytes.</p>
        {error ? <p className="wapp-error" role="alert">{error}</p> : null}
      </form>
    </Modal>
  </>;
}
