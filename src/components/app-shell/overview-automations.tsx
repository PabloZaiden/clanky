import { DataList, ErrorState, LoadingState, type WebAppRoute } from "@pablozaiden/webapp/web";
import type { Automation, Workspace } from "@/shared";
import { isEffectivelyPrivate, shouldObscurePrivateItem } from "../../lib/private-items";
import { getAutomationStatusBadgeVariant, StateText, StatusBadge } from "../common";
import { ClankyListRow } from "./clanky-list-row";

export function OverviewAutomationRow({ automation, workspace, showPrivateItems, onNavigate }: {
  automation: Automation;
  workspace?: Workspace;
  showPrivateItems: boolean;
  onNavigate: (route: WebAppRoute) => void;
}) {
  const privateHidden = shouldObscurePrivateItem(
    isEffectivelyPrivate(automation.config, [workspace]),
    showPrivateItems,
  );
  return (
    <ClankyListRow
      title={automation.config.name}
      description={workspace?.name}
      badge={<StatusBadge variant={getAutomationStatusBadgeVariant(automation.state.status)}><StateText>{automation.state.status}</StateText></StatusBadge>}
      onClick={() => onNavigate({ view: "automation", automationId: automation.config.id })}
      privateHidden={privateHidden}
    />
  );
}

export function OverviewAutomations({
  automations,
  workspaces,
  loading,
  error,
  showPrivateItems,
  onNavigate,
}: {
  automations: Automation[];
  workspaces: Workspace[];
  loading?: boolean;
  error?: string | null;
  showPrivateItems: boolean;
  onNavigate: (route: WebAppRoute) => void;
}) {
  const rows = (
    <DataList>
      {automations.map((automation) => {
        const workspace = workspaces.find((item) => item.id === automation.config.workspaceId);
        return (
          <OverviewAutomationRow
            key={automation.config.id}
            automation={automation}
            workspace={workspace}
            showPrivateItems={showPrivateItems}
            onNavigate={onNavigate}
          />
        );
      })}
    </DataList>
  );
  return (
    <section className="space-y-2" aria-label="Automations">
      <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Automations</h3>
      {error ? <ErrorState title="Could not load automations" description={error} /> : null}
      {loading ? <LoadingState title="Loading automations…" /> : null}
      {automations.length > 0 ? rows : null}
      {!loading && !error && automations.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No automations</p>
      ) : null}
    </section>
  );
}
