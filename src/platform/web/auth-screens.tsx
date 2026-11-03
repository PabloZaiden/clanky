import { startAuthentication, startRegistration } from "@pablozaiden/webapp/auth/browser";
import { useEffect, useState, type FormEvent } from "react";
import type { DeviceVerificationDetails, PasskeyAuthStatusResponse, UserSetupDetails } from "../contracts";
import { appJson, appPagePath } from "./api-client";
import { useAsyncOperation } from "@pablozaiden/webapp/web";
import { Badge, Button, Dialog, Panel, TextField } from "@pablozaiden/webapp/web";
import { DateTimeValue } from "@pablozaiden/webapp/web";

type RegistrationOptions = Parameters<typeof startRegistration>[0]["optionsJSON"];
type AuthenticationOptions = Parameters<typeof startAuthentication>[0]["optionsJSON"];

export function PasskeyAuthScreen({ status, apiKeysEnabled, refresh }: { status: PasskeyAuthStatusResponse; apiKeysEnabled: boolean; refresh: () => Promise<void> }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState("");
  const [apiKeyMode, setApiKeyMode] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const canAuthenticateWithApiKey = apiKeysEnabled
    && status.passkeyRequired
    && !status.authenticated
    && !status.bootstrapRequired
    && !status.ownerPasskeySetupRequired;
  useEffect(() => {
    if (!canAuthenticateWithApiKey) {
      setApiKeyMode(false);
      setApiKey("");
      setError(undefined);
    }
  }, [canAuthenticateWithApiKey]);

  async function register(endpoint: "bootstrap" | "owner-setup") {
    setBusy(true);
    setError(undefined);
    try {
      const body = endpoint === "bootstrap" ? JSON.stringify({ username }) : "{}";
      const options = await appJson<RegistrationOptions>(`/api/passkey-auth/${endpoint}/options`, { method: "POST", body });
      const credential = await startRegistration({ optionsJSON: options });
      await appJson(`/api/passkey-auth/${endpoint}/verify`, { method: "POST", body: JSON.stringify(credential) });
      await refresh();
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function login() {
    setBusy(true);
    setError(undefined);
    try {
      const options = await appJson<AuthenticationOptions>("/api/passkey-auth/authentication/options", { method: "POST", body: "{}" });
      const credential = await startAuthentication({ optionsJSON: options });
      await appJson("/api/passkey-auth/authentication/verify", { method: "POST", body: JSON.stringify(credential) });
      await refresh();
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function loginWithApiKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedApiKey = apiKey.trim();
    if (!normalizedApiKey) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await appJson("/api/passkey-auth/api-key", { method: "POST", body: JSON.stringify({ apiKey: normalizedApiKey }) });
      await refresh();
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function chooseApiKeyMode() {
    setApiKeyMode(true);
    setApiKey("");
    setError(undefined);
  }

  function choosePasskeyMode() {
    setApiKeyMode(false);
    setApiKey("");
    setError(undefined);
  }

  return (
    <main className="wapp-auth-screen">
      <Dialog
        className="wapp-auth-dialog"
        title={status.bootstrapRequired ? "Create owner user" : status.ownerPasskeySetupRequired ? "Set up owner passkey" : "Passkey required"}
        actions={status.bootstrapRequired ? (
          <Button type="button" variant="primary" loading={busy} disabled={!username.trim()} onClick={() => void register("bootstrap")}>Create owner</Button>
        ) : status.ownerPasskeySetupRequired ? (
          <Button type="button" variant="primary" loading={busy} onClick={() => void register("owner-setup")}>Set up owner passkey</Button>
        ) : canAuthenticateWithApiKey && apiKeyMode ? (
          <>
            <Button type="button" variant="ghost" disabled={busy} onClick={choosePasskeyMode}>Use Passkey instead</Button>
            <Button type="submit" form="wapp-api-key-auth-form" variant="primary" loading={busy} disabled={!apiKey.trim()}>Authenticate with API key</Button>
          </>
        ) : (
          <>
            {canAuthenticateWithApiKey ? <Button type="button" variant="ghost" disabled={busy} onClick={chooseApiKeyMode}>Use API Key instead</Button> : null}
            <Button type="button" variant="primary" loading={busy} onClick={() => void login()}>Authenticate</Button>
          </>
        )}
      >
        {error ? <p className="wapp-error">{error}</p> : null}
        {status.bootstrapRequired ? <TextField label="Username" value={username} onChange={(event) => setUsername(event.currentTarget.value)} placeholder="owner" /> : null}
        {canAuthenticateWithApiKey && apiKeyMode ? (
          <>
            <form id="wapp-api-key-auth-form" onSubmit={(event) => void loginWithApiKey(event)}>
              <TextField
                label="API key"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.currentTarget.value)}
                autoComplete="off"
                autoFocus
                spellCheck={false}
              />
            </form>
          </>
        ) : null}
      </Dialog>
    </main>
  );
}

export function UserSetupScreen({ refresh }: { refresh: () => Promise<void> }) {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [details, setDetails] = useState<UserSetupDetails>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("Setup token is missing");
      return;
    }
    void appJson<UserSetupDetails>(`/api/user-setup?token=${encodeURIComponent(token)}`)
      .then(setDetails)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [token]);

  async function setup() {
    setBusy(true);
    setError(undefined);
    try {
      const options = await appJson<RegistrationOptions>("/api/user-setup/options", { method: "POST", body: JSON.stringify({ token }) });
      const credential = await startRegistration({ optionsJSON: options });
      await appJson("/api/user-setup/verify", { method: "POST", body: JSON.stringify({ token, response: credential }) });
      window.history.replaceState(null, "", appPagePath("/"));
      await refresh();
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="wapp-auth-screen">
      <Dialog
        className="wapp-auth-dialog"
        title={details?.kind === "reset" ? "Reset passkey" : "Finish user setup"}
        actions={<Button type="button" variant="primary" loading={busy} disabled={!details} onClick={() => void setup()}>Set up passkey</Button>}
      >
        <p>{details ? `Username: ${details.username}` : "Loading setup link..."}</p>
        {details ? <p className="wapp-muted">Role: {details.role} · Expires <DateTimeValue value={details.expiresAt} /></p> : null}
        {error ? <p className="wapp-error">{error}</p> : null}
      </Dialog>
    </main>
  );
}

export function DeviceVerificationScreen() {
  const params = new URLSearchParams(window.location.search);
  const initialCode = normalizeDeviceCode(params.get("user_code") ?? "");
  const [userCode, setUserCode] = useState(initialCode);
  const [details, setDetails] = useState<DeviceVerificationDetails>();
  const [loadedCode, setLoadedCode] = useState<string>();
  const [error, setError] = useState<string>();
  const {
    pending: lookupPending,
    start: startLookup,
    isCurrent: isLookupCurrent,
    finish: finishLookup,
    invalidate: invalidateLookup,
  } = useAsyncOperation();
  const {
    pending: decisionPending,
    start: startDecision,
    isCurrent: isDecisionCurrent,
    finish: finishDecision,
  } = useAsyncOperation({ abortOnUnmount: false });
  const normalizedCode = normalizeDeviceCode(userCode);

  useEffect(() => {
    if (!normalizedCode) {
      invalidateLookup();
      setDetails(undefined);
      setLoadedCode(undefined);
      setError(undefined);
      return;
    }

    const token = startLookup({ replace: true });
    if (!token) {
      return;
    }
    setError(undefined);
    void appJson<DeviceVerificationDetails>(`/api/auth/device/verification?user_code=${encodeURIComponent(normalizedCode)}`, {
      signal: token.signal,
    })
      .then((nextDetails) => {
        if (!isLookupCurrent(token)) {
          return;
        }
        if (normalizeDeviceCode(nextDetails.userCode) !== normalizedCode) {
          setDetails(undefined);
          setLoadedCode(undefined);
          setError("Device authorization response did not match the requested code.");
          return;
        }
        setDetails(nextDetails);
        setLoadedCode(normalizedCode);
      })
      .catch((err: unknown) => {
        if (!isLookupCurrent(token)) {
          return;
        }
        setDetails(undefined);
        setLoadedCode(undefined);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        finishLookup(token);
      });
  }, [finishLookup, invalidateLookup, isLookupCurrent, normalizedCode, startLookup]);

  async function decide(action: "approve" | "deny") {
    const currentCode = normalizeDeviceCode(userCode);
    if (!details || details.status !== "pending" || loadedCode !== currentCode) {
      return;
    }
    const token = startDecision();
    if (!token) {
      return;
    }
    setError(undefined);
    try {
      const nextDetails = await appJson<DeviceVerificationDetails>(`/api/auth/device/${action}`, {
        method: "POST",
        body: JSON.stringify({ user_code: currentCode }),
        signal: token.signal,
      });
      if (isDecisionCurrent(token)) {
        setDetails(nextDetails);
      }
    } catch (err) {
      if (isDecisionCurrent(token)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      finishDecision(token);
    }
  }

  return (
    <main className="wapp-device-screen">
      <Panel title="Authorize device">
        <div className="wapp-device-stack">
          <TextField
            label="User code"
            value={userCode}
            disabled={decisionPending}
            onInput={(event) => {
              const nextCode = normalizeDeviceCode(event.currentTarget.value);
              if (nextCode === normalizedCode) {
                setUserCode(nextCode);
                return;
              }
              invalidateLookup();
              setUserCode(nextCode);
              setDetails(undefined);
              setLoadedCode(undefined);
              setError(undefined);
            }}
            placeholder="ABCD-2345"
          />
          {error ? <p className="wapp-error">{error}</p> : null}
          {details ? (
            <div className="wapp-device-card">
              <div><strong>Client</strong><span>{details.clientId}</span></div>
              <div><strong>Scope</strong><span>{details.scope}</span></div>
              <div><strong>Status</strong><Badge variant={details.status === "approved" ? "success" : details.status === "denied" ? "error" : details.status === "consumed" ? "disabled" : "warning"}>{details.status}</Badge></div>
              <div><strong>Expires</strong><span><DateTimeValue value={details.expiresAt} /></span></div>
            </div>
          ) : null}
          <div className="wapp-row-actions">
            <Button
              type="button"
              variant="ghost"
              disabled={lookupPending || decisionPending || !details || details.status !== "pending" || loadedCode !== normalizedCode}
              onClick={() => void decide("deny")}
            >
              Deny
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={lookupPending || decisionPending || !details || details.status !== "pending" || loadedCode !== normalizedCode}
              onClick={() => void decide("approve")}
            >
              Approve
            </Button>
          </div>
        </div>
      </Panel>
    </main>
  );
}

function normalizeDeviceCode(value: string): string {
  return value.trim().toUpperCase();
}
