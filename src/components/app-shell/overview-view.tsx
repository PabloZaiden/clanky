import { useMemo } from "react";
import type { Agent, SshServer, SshServerSession } from "../../types";
import type { useTaskGrouping } from "../../hooks";
import { StatusBadge, type BadgeVariant } from "../common";
import { ConfiguredAgentsSection } from "../ConfiguredAgentsSection";
import {
  buildActiveWorkSidebarItems,
  type ShellRoute,
  type SidebarActiveWorkItem,
  type SidebarServerNode,
  type SidebarWorkspaceGroupNode,
} from "./shell-types";
import { ShellPanel } from "./shell-panel";
import { EmptySection } from "./shell-sidebar";
import { getPrivateContainerClassName, isEffectivelyPrivate, shouldObscurePrivateItem } from "../../lib/private-items";

function getActiveWorkRoute(item: SidebarActiveWorkItem): ShellRoute {
  if (item.kind === "task") {
    return { view: "task", taskId: item.taskNode.task.config.id };
  }
  if (item.kind === "chat") {
    return { view: "chat", chatId: item.chatNode.chat.config.id };
  }
  if (item.kind === "ssh-server-chat") {
    return { view: "chat", chatId: item.chatNode.chat.config.id };
  }
  if (item.kind === "ssh-session") {
    return { view: "ssh", sshSessionId: item.sessionNode.session.config.id };
  }
  return { view: "ssh", sshSessionId: item.sessionNode.id };
}

function getActiveWorkTitle(item: SidebarActiveWorkItem): string {
  if (item.kind === "task") {
    return item.taskNode.title;
  }
  if (item.kind === "chat" || item.kind === "ssh-server-chat") {
    return item.chatNode.title;
  }
  return item.sessionNode.title;
}

function getActiveWorkSubtitle(item: SidebarActiveWorkItem): string {
  if (item.kind === "ssh-server-session") {
    return item.serverName;
  }
  if (item.kind === "ssh-server-chat") {
    return item.serverName;
  }
  return item.workspaceName;
}

function getActiveWorkBadge(item: SidebarActiveWorkItem): {
  label: string;
  variant: BadgeVariant;
} {
  if (item.kind === "task") {
    return { label: item.taskNode.badge, variant: item.taskNode.badgeVariant };
  }
  if (item.kind === "chat" || item.kind === "ssh-server-chat") {
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
  if (item.kind === "ssh-server-chat") {
    return shouldObscurePrivateItem(isEffectivelyPrivate(item.chatNode.chat.config, [item.server.config]), showPrivateItems);
  }
  if (item.kind === "ssh-session") {
    return shouldObscurePrivateItem(isEffectivelyPrivate(item.sessionNode.session.config, [item.workspace]), showPrivateItems);
  }
  return shouldObscurePrivateItem(isEffectivelyPrivate(item.sessionNode.session.config, [item.server.config]), showPrivateItems);
}

export function OverviewView({
  servers,
  sessionsByServerId,
  agents,
  agentsLoading,
  agentsError,
  serverNodes,
  workspaceGroups,
  sidebarWorkspaceGroups,
  headerOffsetClassName,
  onNavigate,
  showPrivateItems = false,
}: {
  servers: SshServer[];
  sessionsByServerId: Record<string, SshServerSession[]>;
  agents: Agent[];
  agentsLoading: boolean;
  agentsError: string | null;
  serverNodes: SidebarServerNode[];
  workspaceGroups: ReturnType<typeof useTaskGrouping>["workspaceGroups"];
  sidebarWorkspaceGroups: SidebarWorkspaceGroupNode[];
  headerOffsetClassName?: string;
  onNavigate: (route: ShellRoute) => void;
  showPrivateItems?: boolean;
}) {
  const activeWorkItems = useMemo(
    () => buildActiveWorkSidebarItems(sidebarWorkspaceGroups, { serverNodes }),
    [serverNodes, sidebarWorkspaceGroups],
  );
  const serverMapItems = useMemo(() => {
    return servers.map((server) => ({
      server,
      sessionCount: sessionsByServerId[server.config.id]?.length ?? 0,
    }));
  }, [servers, sessionsByServerId]);
  const workspaceNamesById = useMemo(() => {
    return Object.fromEntries(
      workspaceGroups.map((group) => [group.workspace.id, group.workspace.name]),
    );
  }, [workspaceGroups]);

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
                const privateHidden = isActiveWorkPrivateHidden(item, showPrivateItems);
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={privateHidden ? undefined : () => onNavigate(getActiveWorkRoute(item))}
                    className={`flex w-full min-w-0 items-start justify-between gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left transition ${privateHidden ? "" : "hover:border-gray-300 hover:bg-gray-100 dark:hover:border-gray-700 dark:hover:bg-neutral-800"} dark:border-gray-800 dark:bg-neutral-900 ${getPrivateContainerClassName(privateHidden)}`}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="block break-words text-sm font-medium text-gray-900 dark:text-gray-100 [overflow-wrap:anywhere]">
                        {getActiveWorkTitle(item)}
                      </span>
                      <span className="mt-1 block break-words text-xs text-gray-500 dark:text-gray-400 [overflow-wrap:anywhere]">
                        {getActiveWorkSubtitle(item)}
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

        <ConfiguredAgentsSection
          agents={agents}
          loading={agentsLoading}
          error={agentsError}
          description="Scheduled automations configured across your workspaces."
          workspaceNamesById={workspaceNamesById}
          onSelectAgent={(agentId) => onNavigate({ view: "agent", agentId })}
          isAgentPrivateHidden={(agent) => {
            const workspace = workspaceGroups.find((group) => group.workspace.id === agent.config.workspaceId)?.workspace ?? null;
            return shouldObscurePrivateItem(isEffectivelyPrivate(agent.config, [workspace]), showPrivateItems);
          }}
        />

        <div className="space-y-4 rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50">
          <div>
            <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">Workspaces</h2>
          </div>
          <div className="space-y-2">
            {workspaceGroups.length === 0 ? (
              <EmptySection message="No workspaces yet. Start by creating one." />
            ) : (
              workspaceGroups.map((group) => {
                const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(group.workspace), showPrivateItems);
                return (
                  <button
                    key={group.workspace.id}
                    type="button"
                    onClick={privateHidden ? undefined : () => onNavigate({ view: "workspace", workspaceId: group.workspace.id })}
                    className={`flex w-full min-w-0 items-center justify-between gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left transition ${privateHidden ? "" : "hover:border-gray-300 hover:bg-gray-100 dark:hover:border-gray-700 dark:hover:bg-neutral-800"} dark:border-gray-800 dark:bg-neutral-900 ${getPrivateContainerClassName(privateHidden)}`}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                        {group.workspace.name}
                      </span>
                      <span className="mt-1 block truncate text-xs text-gray-500 dark:text-gray-400">
                        {group.workspace.directory}
                      </span>
                    </span>
                    <span className="shrink-0 whitespace-nowrap rounded-full bg-gray-200 px-2 py-0.5 text-right text-xs font-semibold text-gray-600 dark:bg-neutral-800 dark:text-gray-300">
                      {group.tasks.length} task{group.tasks.length === 1 ? "" : "s"}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="space-y-4 rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50">
          <div>
            <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">Servers</h2>
          </div>
          <div className="space-y-2">
            {serverMapItems.length === 0 ? (
              <EmptySection message="No SSH servers yet. Register one to see it here." />
            ) : (
              serverMapItems.map(({ server, sessionCount }) => {
                const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(server.config), showPrivateItems);
                return (
                  <button
                    key={server.config.id}
                    type="button"
                    onClick={privateHidden ? undefined : () => onNavigate({ view: "ssh-server", serverId: server.config.id })}
                    className={`flex w-full min-w-0 items-start justify-between gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left transition ${privateHidden ? "" : "hover:border-gray-300 hover:bg-gray-100 dark:hover:border-gray-700 dark:hover:bg-neutral-800"} dark:border-gray-800 dark:bg-neutral-900 ${getPrivateContainerClassName(privateHidden)}`}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="block break-words text-sm font-medium text-gray-900 dark:text-gray-100 [overflow-wrap:anywhere]">
                        {server.config.name}
                      </span>
                      <span className="mt-1 block break-words text-xs text-gray-500 dark:text-gray-400 [overflow-wrap:anywhere]">
                        {server.config.username}@{server.config.address}
                      </span>
                    </span>
                    <span className="shrink-0 whitespace-nowrap rounded-full bg-gray-200 px-2 py-0.5 text-right text-xs font-semibold text-gray-600 dark:bg-neutral-800 dark:text-gray-300">
                      {sessionCount} session{sessionCount === 1 ? "" : "s"}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>
    </ShellPanel>
  );
}
