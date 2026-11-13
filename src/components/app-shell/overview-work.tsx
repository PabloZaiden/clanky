import { useMemo } from "react";
import { DataList, EmptyState, ErrorState, LoadingState, Panel, type WebAppRoute } from "@pablozaiden/webapp/web";
import type { Automation, Workspace } from "@/shared";
import {
  buildActiveWorkSidebarItems,
  buildChatHistorySidebarItems,
  type SidebarExecutionHostNode,
  type SidebarWorkspaceGroupNode,
} from "./shell-types";
import { getOverviewActivityTimestamp, getOverviewAttention } from "./overview-activity";
import { OverviewAutomationRow } from "./overview-automations";
import { OverviewWorkItem } from "./overview-work-item";
import { ControlRequestRow } from "../control/control-requests";
import { usePendingControlRequests } from "../control/use-pending-control-requests";
import { Button } from "../common";

const RECENT_ACTIVITY_LIMIT = 5;

export function OverviewWork({
  sidebarWorkspaceGroups, executionHostNodes, automations, workspaces, onNavigate, showPrivateItems,
}: {
  sidebarWorkspaceGroups: SidebarWorkspaceGroupNode[];
  executionHostNodes: SidebarExecutionHostNode[];
  automations: Automation[];
  workspaces: Workspace[];
  onNavigate: (route: WebAppRoute) => void;
  showPrivateItems: boolean;
}) {
  const approvals = usePendingControlRequests();
  const approvalsInitiallyLoading = approvals.loading && approvals.data === undefined;
  const activeItems = useMemo(
    () => buildActiveWorkSidebarItems(sidebarWorkspaceGroups, { executionHostNodes }),
    [executionHostNodes, sidebarWorkspaceGroups],
  );
  const attentionItems = useMemo(() => activeItems.flatMap((item) => {
    const attention = getOverviewAttention(item);
    return attention ? [{ item, attention }] : [];
  }), [activeItems]);
  const attentionAutomations = useMemo(() => automations.filter((automation) => automation.state.status === "error"), [automations]);
  const recentItems = useMemo(() => {
    const history = buildChatHistorySidebarItems(sidebarWorkspaceGroups, { executionHostNodes });
    return [...activeItems, ...history]
      .filter((item) => {
        const isDoneChat =
          (item.kind === "chat" || item.kind === "execution-host-chat")
          && item.chatNode.chat.state.status === "done";
        return !getOverviewAttention(item)
          && !isDoneChat;
      })
      .sort((left, right) => getOverviewActivityTimestamp(right).localeCompare(getOverviewActivityTimestamp(left)))
      .slice(0, RECENT_ACTIVITY_LIMIT);
  }, [activeItems, executionHostNodes, sidebarWorkspaceGroups]);

  return (
    <>
      <Panel title="Needs attention">
        {approvals.error ? <ErrorState title="Could not load approvals" description={String(approvals.error)}
          action={<Button disabled={approvals.loading} onClick={() => void approvals.refresh()}>Retry</Button>} /> : null}
        {approvalsInitiallyLoading ? <LoadingState title="Loading approvals" /> : null}
        {attentionItems.length > 0 || attentionAutomations.length > 0 || Boolean(approvals.data?.length) ? (
          <DataList>
            {approvals.data?.map((request) => (
              <ControlRequestRow key={request.id} request={request} onNavigate={onNavigate} showPrivateItems={showPrivateItems} />
            ))}
            {attentionItems.map(({ item, attention }) => (
              <OverviewWorkItem key={item.key} item={item} attention={attention} onNavigate={onNavigate} showPrivateItems={showPrivateItems} />
            ))}
            {attentionAutomations.map((automation) => (
              <OverviewAutomationRow
                key={automation.config.id}
                automation={automation}
                workspace={workspaces.find((workspace) => workspace.id === automation.config.workspaceId)}
                showPrivateItems={showPrivateItems}
                onNavigate={onNavigate}
              />
            ))}
          </DataList>
        ) : !approvalsInitiallyLoading && !approvals.error ? <EmptyState title="Nothing needs your attention" /> : null}
      </Panel>
      {recentItems.length > 0 ? (
        <Panel title="Recent activity">
          <DataList>
            {recentItems.map((item) => (
              <OverviewWorkItem key={item.key} item={item} onNavigate={onNavigate} showPrivateItems={showPrivateItems} />
            ))}
          </DataList>
        </Panel>
      ) : null}
    </>
  );
}
