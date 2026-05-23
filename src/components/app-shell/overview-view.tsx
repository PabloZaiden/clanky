import { useMemo } from "react";
import type { SshServer, SshServerSession } from "../../types";
import type { useTaskGrouping } from "../../hooks";
import { StatusBadge, type BadgeVariant } from "../common";
import {
  buildActiveWorkSidebarItems,
  type ShellRoute,
  type SidebarActiveWorkItem,
  type SidebarWorkspaceNode,
  type SidebarWorkspaceGroupNode,
} from "./shell-types";
import { ShellPanel } from "./shell-panel";
import { EmptySection } from "./shell-sidebar";

function getActiveWorkRoute(item: SidebarActiveWorkItem): ShellRoute {
  if (item.kind === "task") {
    return { view: "task", taskId: item.taskNode.task.config.id };
  }
  if (item.kind === "chat") {
    return { view: "chat", chatId: item.chatNode.chat.config.id };
  }
  return { view: "ssh", sshSessionId: item.sessionNode.session.config.id };
}

function getActiveWorkTitle(item: SidebarActiveWorkItem): string {
  if (item.kind === "task") {
    return item.taskNode.title;
  }
  if (item.kind === "chat") {
    return item.chatNode.title;
  }
  return item.sessionNode.title;
}

function getActiveWorkBadge(item: SidebarActiveWorkItem): {
  label: string;
  variant: BadgeVariant;
} {
  if (item.kind === "task") {
    return { label: item.taskNode.badge, variant: item.taskNode.badgeVariant };
  }
  if (item.kind === "chat") {
    return { label: item.chatNode.badge, variant: item.chatNode.badgeVariant };
  }
  return { label: item.sessionNode.badge, variant: item.sessionNode.badgeVariant };
}

export function OverviewView({
  servers,
  sessionsByServerId,
  workspaceGroups,
  sidebarWorkspaceGroups,
  quickChatWorkspace,
  headerOffsetClassName,
  onNavigate,
}: {
  servers: SshServer[];
  sessionsByServerId: Record<string, SshServerSession[]>;
  workspaceGroups: ReturnType<typeof useTaskGrouping>["workspaceGroups"];
  sidebarWorkspaceGroups: SidebarWorkspaceGroupNode[];
  quickChatWorkspace: SidebarWorkspaceNode | null;
  headerOffsetClassName?: string;
  onNavigate: (route: ShellRoute) => void;
}) {
  const activeWorkItems = useMemo(
    () => buildActiveWorkSidebarItems(sidebarWorkspaceGroups, { quickChatWorkspace }),
    [quickChatWorkspace, sidebarWorkspaceGroups],
  );
  const serverMapItems = useMemo(() => {
    return servers.map((server) => ({
      server,
      sessionCount: sessionsByServerId[server.config.id]?.length ?? 0,
    }));
  }, [servers, sessionsByServerId]);

  return (
    <ShellPanel
      eyebrow="Overview"
      title="Clanky"
      variant="compact"
      headerOffsetClassName={headerOffsetClassName}
    >
      <div className="space-y-6">
        {activeWorkItems.length > 0 && (
          <div
            data-testid="active-work-card"
            className="space-y-4 rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50"
          >
            <div>
              <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">Active Work</h2>
            </div>
            <div className="space-y-2">
              {activeWorkItems.map((item) => {
                const badge = getActiveWorkBadge(item);
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => onNavigate(getActiveWorkRoute(item))}
                    className="flex w-full min-w-0 items-start justify-between gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left transition hover:border-gray-300 hover:bg-gray-100 dark:border-gray-800 dark:bg-neutral-900 dark:hover:border-gray-700 dark:hover:bg-neutral-800"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="block break-words text-sm font-medium text-gray-900 dark:text-gray-100 [overflow-wrap:anywhere]">
                        {getActiveWorkTitle(item)}
                      </span>
                      <span className="mt-1 block break-words text-xs text-gray-500 dark:text-gray-400 [overflow-wrap:anywhere]">
                        {item.workspaceName}
                      </span>
                    </span>
                    <StatusBadge variant={badge.variant} className="shrink-0">
                      {badge.label}
                    </StatusBadge>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="space-y-4 rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50">
          <div>
            <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">Server maps</h2>
          </div>
          <div className="space-y-2">
            {serverMapItems.length === 0 ? (
              <EmptySection message="No SSH servers yet. Register one to see it here." />
            ) : (
              serverMapItems.map(({ server, sessionCount }) => (
                <button
                  key={server.config.id}
                  type="button"
                  onClick={() => onNavigate({ view: "ssh-server", serverId: server.config.id })}
                  className="flex w-full min-w-0 items-start justify-between gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left transition hover:border-gray-300 hover:bg-gray-100 dark:border-gray-800 dark:bg-neutral-900 dark:hover:border-gray-700 dark:hover:bg-neutral-800"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="block break-words text-sm font-medium text-gray-900 dark:text-gray-100 [overflow-wrap:anywhere]">
                      {server.config.name}
                    </span>
                    <span className="mt-1 block break-words text-xs text-gray-500 dark:text-gray-400 [overflow-wrap:anywhere]">
                      {server.config.username}@{server.config.address}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full bg-gray-200 px-2 py-0.5 text-right text-xs font-semibold text-gray-600 dark:bg-neutral-800 dark:text-gray-300">
                    {sessionCount} session{sessionCount === 1 ? "" : "s"}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="space-y-4 rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50">
          <div>
            <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">Workspaces map</h2>
          </div>
          <div className="space-y-2">
            {workspaceGroups.length === 0 ? (
              <EmptySection message="No workspaces yet. Start by creating one." />
            ) : (
              workspaceGroups.map((group) => (
                <button
                  key={group.workspace.id}
                  type="button"
                  onClick={() => onNavigate({ view: "workspace", workspaceId: group.workspace.id })}
                  className="flex w-full items-center justify-between rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left transition hover:border-gray-300 hover:bg-gray-100 dark:border-gray-800 dark:bg-neutral-900 dark:hover:border-gray-700 dark:hover:bg-neutral-800"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                      {group.workspace.name}
                    </span>
                    <span className="mt-1 block truncate text-xs text-gray-500 dark:text-gray-400">
                      {group.workspace.directory}
                    </span>
                  </span>
                  <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-semibold text-gray-600 dark:bg-neutral-800 dark:text-gray-300">
                    {group.tasks.length} task{group.tasks.length === 1 ? "" : "s"}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </ShellPanel>
  );
}
