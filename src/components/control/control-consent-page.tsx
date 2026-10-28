import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  appJson, CodeValue, DataList, DataListRow, ErrorState, FormActions, FormGroup,
  LoadingState, Page, Panel, useLiveQuery,
} from "@pablozaiden/webapp/web";
import type { ControlGrantSelection } from "@/contracts/schemas/control";
import { Button } from "../common";
import { ControlGrantFields, type ControlConsentOptions } from "./control-grant-fields";
import { useControlExpiry } from "./use-control-expiry";

interface ConsentReview {
  request: string;
  client: { clientId: string; clientName: string };
  resource: string;
  scopes: Array<{ scope: string; description: string }>;
  expiresAt: string;
  consentContext?: ControlConsentOptions;
}

export function ControlConsentPage() {
  const [request] = useState(() => new URLSearchParams(window.location.search).get("request"));
  const query = useLiveQuery({
    enabled: Boolean(request), deps: [request], realtime: false,
    // The OAuth handle is sensitive: use the framework helper without app request-path logging.
    load: (signal) => appJson<ConsentReview>(`/api/oauth/consent?${new URLSearchParams({ request: request! })}`, { signal }),
  });
  const review = query.data;
  const expired = useControlExpiry(review ? Date.parse(review.expiresAt) : undefined);
  const [grant, setGrant] = useState<ControlGrantSelection | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = useRef<AbortController | null>(null);
  const busy = useRef(false);
  useEffect(() => () => { action.current?.abort(); }, []);

  async function decide(decision: "approve" | "deny"): Promise<void> {
    if (!request || !review || expired || busy.current || decision === "approve" && !grant) return;
    busy.current = true;
    setSubmitting(true);
    setError(null);
    const controller = new AbortController();
    action.current = controller;
    try {
      const result = await appJson<{ redirectUri: string }>("/api/oauth/consent", {
        method: "POST", body: JSON.stringify({
          request, decision, ...(decision === "approve" ? { approval: grant } : {}),
        }), signal: controller.signal,
      });
      if (!controller.signal.aborted) window.location.assign(result.redirectUri);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      busy.current = false;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }
  function approve(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void decide("approve");
  }

  return <Page>
    {!request ? <ErrorState title="Consent request missing" description="Start authorization again from your integration." /> : null}
    {query.error ? <ErrorState title="Consent unavailable" description={String(query.error)}
      action={<Button disabled={submitting || query.loading} onClick={() => void query.refresh()}>Retry</Button>} /> : null}
    {!review && query.loading ? <LoadingState title="Loading authorization request" /> : null}
    {review ? <Panel title={review.client.clientName} description="Review this integration before granting access.">
      <CodeValue label="Requested resource" value={review.resource} />
      <DataList>
        {review.scopes.map((scope) => <DataListRow key={scope.scope} title="Requested permission" description={scope.description} />)}
        <DataListRow title="Expires" description={new Date(review.expiresAt).toLocaleString()} />
      </DataList>
      {expired ? <ErrorState title="Consent request expired" description="Start authorization again from your integration." /> : null}
      <form className="space-y-4" onSubmit={approve}>
        {review.consentContext ? <FormGroup title="Authorize access">
          <ControlGrantFields options={review.consentContext} value={grant} onChange={setGrant}
            disabled={submitting || expired} idPrefix="control-consent" />
        </FormGroup> : <ErrorState title="Access choices unavailable" description="No access will be granted. Start a new authorization request." />}
        {error ? <ErrorState title="Consent not completed" description={error} /> : null}
        <FormActions>
          <Button disabled={submitting || expired} onClick={() => void decide("deny")}>Deny</Button>
          <Button type="submit" variant="primary" loading={submitting}
            disabled={expired || !review.consentContext || !grant || grant.level === "workspace" && !grant.workspaceId}>
            Authorize integration
          </Button>
        </FormActions>
      </form>
    </Panel> : null}
  </Page>;
}
