import { useEffect, useRef, useState } from "react";
import {
  CodeValue, ConfirmModal, DataList, DataListRow, ErrorState, FormActions,
  LoadingState, Page, Panel, routeToHash, useLiveQuery,
} from "@pablozaiden/webapp/web";
import type { ControlRequestSnapshot } from "@/contracts/schemas/control";
import { apiRequest } from "../../lib/api-client";
import { Button } from "../common";
import { useControlExpiry } from "./use-control-expiry";

function Result({ value }: { value: unknown }) {
  const json = JSON.stringify(value, null, 2) ?? String(value);
  const pendingId = value && typeof value === "object" && "completion" in value
    && value.completion === "not_executed" && "code" in value
    && value.code === "confirmation_required"
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
    realtime: { resources: ["control-requests"], ids: requestId ? [requestId] : undefined },
  });
  const request = query.data;
  const expired = useControlExpiry(request?.expiresAt);
  const [confirming, setConfirming] = useState(false);
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
    }
  }, [pending]);

  async function submit(body: { approved: boolean }): Promise<void> {
    if (!request || !pending || request.expiresAt <= Date.now() || busy.current) return;
    busy.current = true;
    setSubmitting(true);
    setError(null);
    const controller = new AbortController();
    action.current = controller;
    try {
      const value = await apiRequest<unknown>(`/api/control/requests/${encodeURIComponent(request.id)}/decision`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        signal: controller.signal, action: "Decide control request",
      });
      if (controller.signal.aborted) return;
      setResponse({ value });
      setConfirming(false);
      void query.refresh();
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(`${failure instanceof Error ? failure.message : String(failure)} Check the request status before repeating the action.`);
        setUncertain(true);
        setConfirming(false);
      }
    } finally {
      busy.current = false;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  return <Page>
    <FormActions><a href={routeToHash({ view: "settings", category: "integrations" })}>All approvals</a></FormActions>
    {!requestId ? <ErrorState title="Request not found" description="This link is missing a request identifier." /> : null}
    {query.error ? <ErrorState title="Request unavailable" description={String(query.error)}
      action={<Button disabled={submitting || query.loading} onClick={() => void query.refresh()}>Refresh status</Button>} /> : null}
    {!request && query.loading ? <LoadingState title="Loading control request" /> : null}
    {request ? <>
      <Panel title="Review action">
        <p>{request.description}</p>
        <DataList>
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
        {request.status === "pending" && expired || request.status === "expired" ? <ErrorState title="Request expired"
          description="No further decision can be made. Ask the originating client for a new request." /> : null}
        {request.status === "running" ? <LoadingState title="Operation running" description="Wait for the canonical result before requesting this action again." /> : null}
        {request.status === "completed" && request.result === undefined && !response ? <p role="status">Request finished. No operation result is available.</p> : null}
        {pending && !response ? <FormActions>
          <Button disabled={!available} onClick={() => void submit({ approved: false })}>
            Reject
          </Button>
          <Button variant="primary" disabled={!available}
            loading={submitting} onClick={() => setConfirming(true)}>
            Review approval
          </Button>
        </FormActions> : null}
        <FormActions><Button disabled={submitting || query.loading} onClick={async () => {
          setError(null);
          await query.refresh();
          setUncertain(false);
        }}>Refresh status</Button></FormActions>
        {error ? <ErrorState title="Action not confirmed" description={error} /> : null}
      </Panel>
      {request.result !== undefined || response ? <Result value={request.result !== undefined ? request.result : response?.value} /> : null}
    </> : null}
    <ConfirmModal isOpen={confirming && Boolean(pending)} title="Approve this exact action?"
      message={request?.description ?? ""} confirmLabel="Approve action" variant="danger"
      loading={submitting} onClose={() => { if (!submitting) setConfirming(false); }}
      onConfirm={() => void submit({ approved: true })}>
      <p>Approval permits one attempt with the frozen arguments shown on this page.</p>
    </ConfirmModal>
  </Page>;
}
