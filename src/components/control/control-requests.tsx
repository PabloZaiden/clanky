import {
  DataList, EmptyState, ErrorState, LoadingState, type WebAppRoute,
} from "@pablozaiden/webapp/web";
import type { ControlRequestSummary } from "@/contracts/schemas/control";
import { Button } from "../common";
import { usePendingControlRequests } from "./use-pending-control-requests";
import { ClankyListRow } from "../app-shell/clanky-list-row";
import { shouldObscurePrivateItem } from "../../lib/private-items";

export function ControlRequestRow({ request, onNavigate, showPrivateItems }: {
  request: ControlRequestSummary;
  onNavigate: (route: WebAppRoute) => void;
  showPrivateItems: boolean;
}) {
  return <ClankyListRow
    title={request.description}
    description={request.kind === "confirmation" ? "Approval required" : "Private SSH credential required"}
    meta={`Expires ${new Date(request.expiresAt).toLocaleString()}`}
    metaPlacement="below"
    privateHidden={shouldObscurePrivateItem(request.isPrivate, showPrivateItems)}
    onClick={() => onNavigate({ view: "control-request", requestId: request.id })}
  />;
}

export function PendingControlRequests({ onNavigate, showPrivateItems }: {
  onNavigate: (route: WebAppRoute) => void;
  showPrivateItems: boolean;
}) {
  const query = usePendingControlRequests();
  if (!query.available) return <EmptyState title="Approvals unavailable"
    description="A passkey-authenticated session is required to review approvals." />;
  return <>
    {query.error ? <ErrorState title="Could not load approvals" description={String(query.error)}
      action={<Button disabled={query.loading} onClick={() => void query.refresh()}>Retry</Button>} /> : null}
    {!query.data && query.loading ? <LoadingState title="Loading approvals" /> : null}
    {query.data?.length ? <DataList>
      {query.data.map((request) => <ControlRequestRow key={request.id} request={request} onNavigate={onNavigate}
        showPrivateItems={showPrivateItems} />)}
    </DataList> : query.data && !query.error ? <EmptyState title="No pending approvals" /> : null}
  </>;
}
