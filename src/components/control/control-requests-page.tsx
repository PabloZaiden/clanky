import {
  DataList, DataListRow, EmptyState, ErrorState, LoadingState, Page, Panel, type WebAppRoute,
} from "@pablozaiden/webapp/web";
import type { ControlRequestSummary } from "@/contracts/schemas/control";
import { Button } from "../common";
import { usePendingControlRequests } from "./use-pending-control-requests";

export function ControlRequestRow({ request, onNavigate }: {
  request: ControlRequestSummary;
  onNavigate: (route: WebAppRoute) => void;
}) {
  return <DataListRow
    title={request.description}
    description={request.kind === "confirmation" ? "Approval required" : "Private SSH credential required"}
    meta={`Expires ${new Date(request.expiresAt).toLocaleString()}`}
    metaPlacement="below"
    onClick={() => onNavigate({ view: "control-request", requestId: request.id })}
  />;
}

export function ControlRequestsPage({ onNavigate }: { onNavigate: (route: WebAppRoute) => void }) {
  const query = usePendingControlRequests();
  return <Page>
    <Panel title="Pending requests">
      {query.error ? <ErrorState title="Could not load approvals" description={String(query.error)}
        action={<Button disabled={query.loading} onClick={() => void query.refresh()}>Retry</Button>} /> : null}
      {!query.data && query.loading ? <LoadingState title="Loading approvals" /> : null}
      {query.data?.length ? <DataList>
        {query.data.map((request) => <ControlRequestRow key={request.id} request={request} onNavigate={onNavigate} />)}
      </DataList> : query.data && !query.error ? <EmptyState title="No pending approvals" /> : null}
    </Panel>
  </Page>;
}
