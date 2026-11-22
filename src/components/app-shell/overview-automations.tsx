import type { WebAppRoute } from "@pablozaiden/webapp/web";
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
