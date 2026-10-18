import type { ReactNode } from "react";
import type { Workspace } from "@/shared";
import { WorkspaceIdentity } from "../common";
import { ActiveWorkMetadata, type ActiveWorkSidebarItemType } from "./active-work-sidebar-item";
import { ClankyListRow } from "./clanky-list-row";

export function WorkItemRow({
  title,
  workspace,
  subtitle,
  badge,
  itemType,
  lastInteractionAt,
  onClick,
  privateHidden,
}: {
  title: string;
  workspace?: Workspace;
  subtitle?: string;
  badge: ReactNode;
  itemType: ActiveWorkSidebarItemType;
  lastInteractionAt: string;
  onClick?: () => void;
  privateHidden?: boolean;
}) {
  return (
    <ClankyListRow
      title={(
        <span className="flex min-w-0 items-center justify-between gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
          {workspace ? (
            <WorkspaceIdentity workspace={workspace} iconSize="h-3.5 w-3.5" showProviderIcon={false} />
          ) : <span className="min-w-0 truncate">{subtitle}</span>}
          <span className="shrink-0">{badge}</span>
        </span>
      )}
      description={<span className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</span>}
      descriptionClassName="whitespace-normal break-words"
      meta={(
        <ActiveWorkMetadata
          itemType={itemType}
          lastInteractionAt={lastInteractionAt}
          workspace={workspace}
        />
      )}
      metaPlacement="footer"
      onClick={onClick}
      privateHidden={privateHidden}
    />
  );
}
