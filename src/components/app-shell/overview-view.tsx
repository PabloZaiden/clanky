import { useMemo } from "react";
import type { Agent, SshServer, SshServerSession } from "@/shared";
import type { useTaskGrouping } from "../../hooks";
import { StatusBadge, type BadgeVariant } from "../common";
import { ConfiguredAgentsSection } from "../ConfiguredAgentsSection";
import {
  buildActiveWorkSidebarItems,
  type SidebarActiveWorkItem,
  type SidebarServerNode,
  type SidebarWorkspaceGroupNode,
} from "./shell-types";
import { DataList, DataListRow, EmptyState, Panel, type WebAppRoute } from "@pablozaiden/webapp/web";
import { getPrivateContainerClassName, isEffectivelyPrivate, shouldObscurePrivateItem } from "../../lib/private-items";

function getActiveWorkRoute(item: SidebarActiveWorkItem): WebAppRoute {
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
  onNavigate: (route: WebAppRoute) => void;
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
  const visibleWorkspaceIds = useMemo(
    () => new Set(workspaceGroups.map((group) => group.workspace.id)),
    [workspaceGroups],
  );
  const visibleAgents = useMemo(
    () => agents.filter((agent) => visibleWorkspaceIds.has(agent.config.workspaceId)),
    [agents, visibleWorkspaceIds],
  );

  return (
    <div className="space-y-6">
        {activeWorkItems.length > 0 && (
          <div data-testid="active-work-card">
            <Panel title="Active Work">
              <DataList>
              {activeWorkItems.map((item) => {
                const badge = getActiveWorkBadge(item);
                const privateHidden = isActiveWorkPrivateHidden(item, showPrivateItems);
                return (
                  <div key={item.key} className={getPrivateContainerClassName(privateHidden)}>
                    <DataListRow
                      title={getActiveWorkTitle(item)}
                      description={getActiveWorkSubtitle(item)}
                      badge={<StatusBadge variant={badge.variant}>{badge.label}</StatusBadge>}
                      onClick={privateHidden ? undefined : () => onNavigate(getActiveWorkRoute(item))}
                    />
                  </div>
                );
              })}
              </DataList>
            </Panel>
          </div>
        )}

        <ConfiguredAgentsSection
          agents={visibleAgents}
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

        <Panel title="Workspaces">
          <DataList>
            {workspaceGroups.length === 0 ? (
              <EmptyState title="No workspaces yet" description="Start by creating one." />
            ) : workspaceGroups.map((group) => {
              const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(group.workspace), showPrivateItems);
              return (
                <div key={group.workspace.id} className={getPrivateContainerClassName(privateHidden)}>
                  <DataListRow
                    title={group.workspace.name}
                    description={group.workspace.directory}
                    meta={`${group.tasks.length} task${group.tasks.length === 1 ? "" : "s"}`}
                    onClick={privateHidden ? undefined : () => onNavigate({ view: "workspace", workspaceId: group.workspace.id })}
                  />
                </div>
              );
            })}
          </DataList>
        </Panel>

        <Panel title="Servers">
          <DataList>
            {serverMapItems.length === 0 ? (
              <EmptyState title="No SSH servers yet" description="Register one to see it here." />
            ) : serverMapItems.map(({ server, sessionCount }) => {
              const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(server.config), showPrivateItems);
              return (
                <div key={server.config.id} className={getPrivateContainerClassName(privateHidden)}>
                  <DataListRow
                    title={server.config.name}
                    description={`${server.config.username}@${server.config.address}`}
                    meta={`${sessionCount} session${sessionCount === 1 ? "" : "s"}`}
                    onClick={privateHidden ? undefined : () => onNavigate({ view: "ssh-server", serverId: server.config.id })}
                  />
                </div>
              );
            })}
          </DataList>
        </Panel>
      </div>
  );
}
