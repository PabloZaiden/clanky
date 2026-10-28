import { useEffect, useRef, useState } from "react";
import {
  CodeValue, ConfirmModal, DataList, DataListRow, ErrorState, FormActions,
  LoadingState, Page, Panel, routeToHash, useLiveQuery,
} from "@pablozaiden/webapp/web";
import type { ControlRequestSnapshot } from "@/contracts/schemas/control";
import { apiRequest } from "../../lib/api-client";
import { getStoredSshCredentialToken, storeSshServerPassword } from "../../lib/ssh-browser-credentials";
import { Button } from "../common";
import { ServerPasswordModal } from "../app-shell/server-password-modal";
import { useControlExpiry } from "./use-control-expiry";

function Result({ value }: { value: unknown }) {
  const json = JSON.stringify(value, null, 2) ?? String(value);
  const pendingId = value && typeof value === "object" && "completion" in value
    && value.completion === "not_executed" && "code" in value
    && (value.code === "credential_required" || value.code === "confirmation_required")
    && "requestId" in value && typeof value.requestId === "string" ? value.requestId : undefined;
  return <Panel title="Operation result">
    {pendingId ? <p><a href={routeToHash({ view: "control-request", requestId: pendingId })}>Review the required follow-up request</a></p> : null}
    <CodeValue label="Copy canonical result" value={json} />
    <pre aria-label="Canonical result" className="overflow-auto whitespace-pre-wrap break-words text-sm">{json}</pre>
  </Panel>;
}

export function ControlRequestPage({ requestId }: { requestId: string | undefined }) {
  const query = useLiveQuery({
    enabled: Boolean(requestId), deps: [requestId],
    load: (signal) => apiRequest<ControlRequestSnapshot>(`/api/control/requests/${encodeURIComponent(requestId!)}`, { signal }),
    realtime: { resources: ["control-requests"] },
  });
  const request = query.data;
  const expired = useControlExpiry(request?.expiresAt);
  const [confirming, setConfirming] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<{ value: unknown } | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const action = useRef<AbortController | null>(null);
  const busy = useRef(false);
  useEffect(() => () => { action.current?.abort(); }, []);
  const pending = request?.status === "pending" && !expired;
  const available = pending && !submitting && !response && !uncertain && !query.loading && !query.error;
  useEffect(() => {
    if (!pending) {
      setConfirming(false);
      setPasswordOpen(false);
      setPassword("");
    }
  }, [pending]);

  async function submit(kind: "decision" | "credential", body: { approved: boolean } | { credentialToken: string | null }): Promise<void> {
    if (!request || !pending || request.expiresAt <= Date.now() || busy.current) return;
    busy.current = true;
    setSubmitting(true);
    setError(null);
    const controller = new AbortController();
    action.current = controller;
    try {
      const value = await apiRequest<unknown>(`/api/control/requests/${encodeURIComponent(request.id)}/${kind}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        signal: controller.signal, action: kind === "decision" ? "Decide control request" : "Supply private SSH credential",
      });
      if (controller.signal.aborted) return;
      setResponse({ value });
      setConfirming(false);
      setPasswordOpen(false);
      setPassword("");
      void query.refresh();
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(`${failure instanceof Error ? failure.message : String(failure)} Check the request status before repeating the action.`);
        setUncertain(true);
        setConfirming(false);
        setPasswordOpen(false);
        setPassword("");
      }
    } finally {
      busy.current = false;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  async function openCredential(): Promise<void> {
    if (!available || !request?.serverId || busy.current) return;
    busy.current = true;
    setSubmitting(true);
    setError(null);
    const controller = new AbortController();
    action.current = controller;
    try {
      const credentialToken = await getStoredSshCredentialToken(request.serverId);
      if (controller.signal.aborted) return;
      busy.current = false;
      setSubmitting(false);
      if (credentialToken) await submit("credential", { credentialToken });
      else setPasswordOpen(true);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      busy.current = false;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  async function supplyPassword(): Promise<void> {
    if (!available || !request?.serverId || busy.current) return;
    busy.current = true;
    setSubmitting(true);
    setError(null);
    const controller = new AbortController();
    action.current = controller;
    try {
      await storeSshServerPassword(request.serverId, password);
      if (controller.signal.aborted) return;
      const credentialToken = await getStoredSshCredentialToken(request.serverId);
      if (controller.signal.aborted) return;
      if (!credentialToken) throw new Error("The browser could not prepare the SSH credential.");
      setPassword("");
      busy.current = false;
      setSubmitting(false);
      await submit("credential", { credentialToken });
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      busy.current = false;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  return <Page>
    {!requestId ? <ErrorState title="Request not found" description="This link is missing a request identifier." /> : null}
    {query.error ? <ErrorState title="Request unavailable" description={String(query.error)}
      action={<Button disabled={submitting || query.loading} onClick={() => void query.refresh()}>Refresh status</Button>} /> : null}
    {!request && query.loading ? <LoadingState title="Loading control request" /> : null}
    {request ? <>
      <Panel title={request.kind === "confirmation" ? "Review action" : "Private SSH credential"}>
        <p>{request.description}</p>
        <DataList>
          {request.serverName ? <DataListRow title="Server" description={request.serverName} /> : null}
          <DataListRow title="Status" description={request.status === "pending" && expired ? "Expired" : request.status} />
          <DataListRow title="Expires" description={new Date(request.expiresAt).toLocaleString()} />
        </DataList>
        {request.operation ? <details>
          <summary>Exact operation arguments</summary>
          <CodeValue label="Copy frozen arguments" value={JSON.stringify(request.operation, null, 2)} />
          <pre aria-label="Exact operation arguments" className="overflow-auto whitespace-pre-wrap break-words text-sm">
            {JSON.stringify(request.operation, null, 2)}
          </pre>
        </details> : null}
        {request.kind === "ssh_credential" && pending ? <p className="text-sm text-gray-600 dark:text-gray-400">
          The password stays in this browser. Only a temporary credential is sent privately to Clanky, never to the requesting agent.
        </p> : null}
        {request.status === "pending" && expired || request.status === "expired" ? <ErrorState title="Request expired"
          description="No further decision can be made. Ask the originating client for a new request." /> : null}
        {request.status === "running" ? <LoadingState title="Operation running" description="Wait for the canonical result before requesting this action again." /> : null}
        {request.status === "completed" && request.result === undefined && !response ? <p role="status">Request finished. No operation result is available.</p> : null}
        {pending && !response ? <FormActions>
          <Button disabled={!available} onClick={() => void submit(request.kind === "confirmation" ? "decision" : "credential",
            request.kind === "confirmation" ? { approved: false } : { credentialToken: null })}>
            {request.kind === "confirmation" ? "Reject" : "Cancel request"}
          </Button>
          <Button variant="primary" disabled={!available || request.kind === "ssh_credential" && !request.serverId}
            loading={submitting} onClick={() => request.kind === "confirmation" ? setConfirming(true) : void openCredential()}>
            {request.kind === "confirmation" ? "Review approval" : "Supply SSH credential"}
          </Button>
        </FormActions> : null}
        <FormActions><Button disabled={submitting || query.loading} onClick={async () => {
          setError(null);
          await query.refresh();
          setUncertain(false);
        }}>Refresh status</Button></FormActions>
        {error && !passwordOpen ? <ErrorState title="Action not confirmed" description={error} /> : null}
      </Panel>
      {request.result !== undefined || response ? <Result value={request.result !== undefined ? request.result : response?.value} /> : null}
    </> : null}
    <ConfirmModal isOpen={confirming && Boolean(pending)} title="Approve this exact action?"
      message={request?.description ?? ""} confirmLabel="Approve action" variant="danger"
      loading={submitting} onClose={() => { if (!submitting) setConfirming(false); }}
      onConfirm={() => void submit("decision", { approved: true })}>
      <p>Approval permits one attempt with the frozen arguments shown on this page.</p>
    </ConfirmModal>
    <ServerPasswordModal isOpen={passwordOpen && Boolean(pending)} serverName={request?.serverName ?? "SSH server"}
      password={password} error={error} submitting={submitting} onPasswordChange={setPassword}
      description="Supply this SSH credential privately. It is never included in an agent response."
      onClose={() => { if (!submitting) void submit("credential", { credentialToken: null }); }} onSubmit={supplyPassword} />
  </Page>;
}
