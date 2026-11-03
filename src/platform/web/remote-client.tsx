import { Fragment, useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { Button, CodeValue, Dialog, FormSection, TextField } from "@pablozaiden/webapp/web";
import {
  cancelClientLogin, getClientSession, hasNativeAuthorizationBrowser,
  initializeClientSession, loginClient, logoutClient, selectClientEndpoint,
  subscribeClientSession,
} from "./client-session";
import { SettingsFieldRow } from "@pablozaiden/webapp/web";
import { ThemeProvider } from "@pablozaiden/webapp/web";
import { getClientConnectionPickerUrl } from "./api-client";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function EndpointForm({ endpoint, onConnected }: { endpoint?: string; onConnected?: () => void }) {
  const [value, setValue] = useState(endpoint ?? "");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await selectClientEndpoint(value);
      onConnected?.();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)}>
      <TextField label="API server" type="url" value={value} required autoComplete="url"
        placeholder="https://api.example.com" onChange={(event) => setValue(event.currentTarget.value)} />
      {error ? <p className="wapp-error" role="alert">{error}</p> : null}
      <div className="wapp-row-actions"><Button type="submit" loading={busy}>Connect</Button></div>
    </form>
  );
}

export function RemoteClientBoundary({ children }: { children: ReactNode }) {
  const connectionPickerUrl = getClientConnectionPickerUrl();
  const session = useSyncExternalStore(subscribeClientSession, getClientSession, getClientSession);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [verification, setVerification] = useState<{ url: string; code: string }>();
  useEffect(() => {
    void initializeClientSession();
    return cancelClientLogin;
  }, []);
  useEffect(() => {
    setError(undefined);
    setVerification(undefined);
  }, [session.endpoint]);
  if (!session.enabled) return children;
  if (session.authenticated) return <Fragment key={session.generation}>{children}</Fragment>;
  async function startLogin() {
    const popup = hasNativeAuthorizationBrowser() ? null : window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    setBusy(true);
    setError(undefined);
    try {
      await loginClient((info) => {
        setVerification(info);
        if (popup) popup.location.replace(info.url);
      });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setError(errorMessage(error));
    } finally {
      if (popup && !popup.closed) popup.close();
      setBusy(false);
      setVerification(undefined);
    }
  }
  const chooseEndpoint = !session.endpoint || editing || Boolean(session.error);
  return (
    <ThemeProvider><main className="wapp-auth-screen">
      <Dialog title={chooseEndpoint ? "Connect to server" : "Sign in"}
        actions={!chooseEndpoint || connectionPickerUrl ? <>
          {connectionPickerUrl ? <a href={connectionPickerUrl}>Change connection</a> : null}
          {!chooseEndpoint ? <>
            <Button type="button" disabled={busy} onClick={() => setEditing(true)}>Change server</Button>
            {busy ? <Button type="button" onClick={cancelClientLogin}>Cancel</Button>
              : <Button type="button" disabled={!session.ready} onClick={() => void startLogin()}>Sign in</Button>}
          </> : null}
        </> : undefined}>
        {chooseEndpoint ? <EndpointForm endpoint={session.endpoint} onConnected={() => setEditing(false)} />
          : <CodeValue label="API server" value={session.endpoint ?? ""} />}
        {verification ? <>
          <CodeValue label="Authorization code" value={verification.code} />
          <a href={verification.url} target="_blank" rel="noopener noreferrer">Open authorization page</a>
          <p role="status">Waiting for authorization…</p>
        </> : null}
        {error || session.error ? <p className="wapp-error" role="alert">{error ?? session.error?.message}</p> : null}
      </Dialog>
    </main></ThemeProvider>
  );
}

export function RemoteClientSettings() {
  const connectionPickerUrl = getClientConnectionPickerUrl();
  const session = useSyncExternalStore(subscribeClientSession, getClientSession, getClientSession);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();
  if (!session.enabled && !connectionPickerUrl) return null;
  async function signOut() {
    try {
      await logoutClient();
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  return (
    <FormSection title="Connection">
      {session.enabled ? <SettingsFieldRow title="API server" content={<span>{session.endpoint}</span>} actions={<>
        <Button onClick={() => setEditing(!editing)}>Change server</Button>
        <Button onClick={() => void signOut()}>Sign out</Button>
      </>} /> : null}
      {session.enabled && editing ? <EndpointForm endpoint={session.endpoint} /> : null}
      {connectionPickerUrl ? <SettingsFieldRow title="Client"
        actions={<a href={connectionPickerUrl}>Change connection</a>} /> : null}
      {error ? <p className="wapp-error" role="alert">{error}</p> : null}
    </FormSection>
  );
}
