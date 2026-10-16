import type { Workspace } from "@/shared";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import { isEffectivelyPrivate, shouldObscurePrivateItem } from "../../lib/private-items";
import { StateText, StatusBadge, WorkspaceIdentity, type BadgeVariant } from "../common";
import {
  ActiveWorkMetadata,
  type ActiveWorkSidebarItemType,
} from "./active-work-sidebar-item";
import { ClankyListRow } from "./clanky-list-row";
import { getActiveWorkItemTimestamp, type SidebarActiveWorkItem } from "./shell-types";

function getActiveWorkRoute(item: SidebarActiveWorkItem): WebAppRoute {
  if (item.kind === "task") {
    return { view: "task", taskId: item.taskNode.task.config.id };
  }
  if (item.kind === "chat") {
    return { view: "chat", chatId: item.chatNode.chat.config.id };
  }
  if (item.kind === "execution-host-chat") {
    return { view: "chat", chatId: item.chatNode.chat.config.id };
  }
  if (item.kind === "terminal-session") {
    return { view: "terminal", terminalSessionId: item.sessionNode.session.config.id };
  }
  return { view: "terminal", terminalSessionId: item.sessionNode.session.config.id };
}

function getActiveWorkTitle(item: SidebarActiveWorkItem): string {
  if (item.kind === "task") {
    return item.taskNode.title;
  }
  if (item.kind === "chat" || item.kind === "execution-host-chat") {
    return item.chatNode.title;
  }
  return item.sessionNode.title;
}

function getActiveWorkItemType(item: SidebarActiveWorkItem): ActiveWorkSidebarItemType {
  if (item.kind === "task") {
    return "Task";
  }
  if (item.kind === "chat" || item.kind === "execution-host-chat") {
    return "Chat";
  }
  return "Terminal";
}

function getActiveWorkSubtitle(item: SidebarActiveWorkItem): string {
  if (item.kind === "execution-host-terminal" || item.kind === "execution-host-chat") {
    return item.host.name;
  }
  return item.workspaceName;
}

function getActiveWorkWorkspace(item: SidebarActiveWorkItem): Workspace | null {
  return item.kind === "task" || item.kind === "chat" || item.kind === "terminal-session"
    ? item.workspace
    : null;
}

function getActiveWorkBadge(item: SidebarActiveWorkItem): {
  label: string;
  variant: BadgeVariant;
} {
  if (item.kind === "task") {
    return { label: item.taskNode.badge, variant: item.taskNode.badgeVariant };
  }
  if (item.kind === "chat" || item.kind === "execution-host-chat") {
    return { label: item.chatNode.badge, variant: item.chatNode.badgeVariant };
  }
  return { label: item.sessionNode.badge, variant: item.sessionNode.badgeVariant };
}

function isActiveWorkPrivateHidden(item: SidebarActiveWorkItem, showPrivateItems: boolean): boolean {
  if (item.kind === "task") {
    return shouldObscurePrivateItem(isEffectivelyPrivate(item.taskNode.task.config, [item.workspace]), showPrivateItems);
  }
  if (item.kind === "chat") {
    return shouldObscurePrivateItem(isEffectivelyPrivate(item.chatNode.chat.config, [item.workspace]), showPrivateItems);
  }
  if (item.kind === "execution-host-chat") {
    return shouldObscurePrivateItem(isEffectivelyPrivate(item.chatNode.chat.config, [item.host]), showPrivateItems);
  }
  if (item.kind === "terminal-session") {
    return shouldObscurePrivateItem(isEffectivelyPrivate(item.sessionNode.session.config, [item.workspace]), showPrivateItems);
  }
  return shouldObscurePrivateItem(isEffectivelyPrivate(item.sessionNode.session.config, [item.host]), showPrivateItems);
}

export function OverviewWorkItem({
  item,
  onNavigate,
  showPrivateItems,
}: {
  item: SidebarActiveWorkItem;
  onNavigate: (route: WebAppRoute) => void;
  showPrivateItems: boolean;
}) {
  const badge = getActiveWorkBadge(item);
  const privateHidden = isActiveWorkPrivateHidden(item, showPrivateItems);
  const workspace = getActiveWorkWorkspace(item);

  return (
    <ClankyListRow
      title={getActiveWorkTitle(item)}
      description={workspace
        ? <WorkspaceIdentity workspace={workspace} showProviderIcon={false} />
        : getActiveWorkSubtitle(item)}
      meta={(
        <ActiveWorkMetadata
          itemType={getActiveWorkItemType(item)}
          lastInteractionAt={getActiveWorkItemTimestamp(item)}
          workspace={workspace ?? undefined}
        />
      )}
      metaPlacement="footer"
      badge={<StatusBadge variant={badge.variant}><StateText>{badge.label}</StateText></StatusBadge>}
      onClick={!privateHidden ? () => onNavigate(getActiveWorkRoute(item)) : undefined}
      privateHidden={privateHidden}
    />
  );
}
