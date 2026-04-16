import type { MouseEvent } from "react";
import type { Workspace } from "../../types";
import { CodeIcon, GearIcon, RefreshIcon, SidebarIcon } from "../common";
import { getShellRouteUrl, isModifiedNavigationClick } from "./shell-navigation";
import { EmptySection, ShellSection, SidebarTreeItem, SidebarTreeSection } from "./shell-sidebar";
import {
  getSidebarGroupCollapseKey,
  getSidebarLoopCollapseKey,
  getSidebarSectionCollapseKey,
  getSidebarServerCollapseKey,
  getSidebarServerSectionCollapseKey,
  getSidebarWorkspaceCollapseKey,
  getSidebarWorkspaceSectionCollapseKey,
  type ShellRoute,
  type SidebarLoopNode,
  type SidebarServerNode,
  type SidebarWorkspaceGroupNode,
} from "./shell-types";

interface ShellSidebarNavProps {
  route: ShellRoute;
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  navigateWithinShell: (route: ShellRoute) => void;
  hideSidebar: () => void;
  isNodeCollapsed: (collapseKey: string) => boolean;
  toggleNodeCollapsed: (collapseKey: string) => void;
  workspaces: Workspace[];
  workspaceGroups: SidebarWorkspaceGroupNode[];
  serverNodes: SidebarServerNode[];
  version: string | undefined;
}

const iconButtonBase =
  "inline-flex h-10 w-10 items-center justify-center rounded-xl border bg-white shadow-sm transition dark:bg-neutral-900";
const iconButtonDefault =
  `${iconButtonBase} border-gray-200 text-gray-600 hover:border-gray-300 hover:text-gray-900 dark:border-gray-800 dark:text-gray-300 dark:hover:border-gray-700 dark:hover:text-gray-100`;
const iconButtonActive =
  `${iconButtonBase} border-gray-900 text-gray-900 dark:border-gray-100 dark:text-gray-100`;

export function ShellSidebarNav({
  route,
  sidebarOpen,
  sidebarCollapsed,
  navigateWithinShell,
  hideSidebar,
  isNodeCollapsed,
  toggleNodeCollapsed,
  workspaces,
  workspaceGroups,
  serverNodes,
  version,
}: ShellSidebarNavProps) {
  function handleSidebarItemClick(event: MouseEvent<HTMLButtonElement>, nextRoute: ShellRoute) {
    if (isModifiedNavigationClick(event)) {
      window.open(getShellRouteUrl(nextRoute), "_blank", "noopener,noreferrer");
      return;
    }

    navigateWithinShell(nextRoute);
  }

  function isWorkspaceActive(workspaceId: string): boolean {
    return (
      (
        (route.view === "workspace" || route.view === "workspace-settings")
        && route.workspaceId === workspaceId
      )
      || (
        route.view === "code-explorer"
        && route.target?.contentType === "workspace"
        && route.target.workspaceId === workspaceId
      )
    );
  }

  function isLoopActive(loopId: string): boolean {
    return (
      ((route.view === "loop" || route.view === "loop-files") && route.loopId === loopId)
      || (
        route.view === "code-explorer"
        && route.target?.contentType === "loop"
        && route.target.loopId === loopId
      )
    );
  }

  function isChatActive(chatId: string): boolean {
    return (
      (route.view === "chat" && route.chatId === chatId)
      || (
        route.view === "code-explorer"
        && route.target?.contentType === "chat"
        && route.target.chatId === chatId
      )
    );
  }

  function isServerActive(serverId: string): boolean {
    return (
      ((
        route.view === "ssh-server"
        || route.view === "ssh-server-settings"
        || route.view === "server-files"
        || route.view === "server-arise"
      )
      && route.serverId === serverId)
      || (
        route.view === "code-explorer"
        && route.target?.contentType === "server"
        && route.target.serverId === serverId
      )
    );
  }

  function renderLoopNodes({
    groupKey,
    workspaceId,
    loopNodes,
  }: {
    groupKey: SidebarWorkspaceGroupNode["key"];
    workspaceId: string;
    loopNodes: SidebarLoopNode[];
  }) {
    return loopNodes.map((loopNode) => {
      const loopCollapseKey = getSidebarLoopCollapseKey(
        "workspaces",
        groupKey,
        workspaceId,
        loopNode.loop.config.id,
      );
      const loopCollapsed = isNodeCollapsed(loopCollapseKey);
      return (
        <div key={loopNode.loop.config.id} className="space-y-1">
          <SidebarTreeItem
            active={isLoopActive(loopNode.loop.config.id)}
            title={loopNode.title}
            badge={loopNode.badge}
            badgeVariant={loopNode.badgeVariant}
            indentLevel={3}
            collapsed={loopNode.sessions.length > 0 ? loopCollapsed : undefined}
            onToggle={loopNode.sessions.length > 0
              ? () => toggleNodeCollapsed(loopCollapseKey)
              : undefined}
            onClick={(event) => handleSidebarItemClick(event, {
              view: "loop",
              loopId: loopNode.loop.config.id,
            })}
          />
          {loopNode.sessions.length > 0 && !loopCollapsed && (
            <div className="space-y-1">
              {loopNode.sessions.map((sessionNode) => (
                <SidebarTreeItem
                  key={sessionNode.session.config.id}
                  active={route.view === "ssh" && route.sshSessionId === sessionNode.session.config.id}
                  title={sessionNode.title}
                  subtitle={sessionNode.subtitle}
                  badge={sessionNode.badge}
                  badgeVariant={sessionNode.badgeVariant}
                  indentLevel={4}
                  onClick={(event) => handleSidebarItemClick(event, {
                    view: "ssh",
                    sshSessionId: sessionNode.session.config.id,
                  })}
                />
              ))}
            </div>
          )}
        </div>
      );
    });
  }

  const workspacesCollapseKey = getSidebarSectionCollapseKey("workspaces");
  const serversCollapseKey = getSidebarSectionCollapseKey("ssh-servers");
  const visibleWorkspaceGroups = workspaceGroups.filter((group) => group.workspaces.length > 0);

  return (
    <aside
      hidden={sidebarCollapsed && !sidebarOpen}
      aria-hidden={sidebarCollapsed && !sidebarOpen}
      className={[
        "fixed inset-y-0 left-0 z-40 flex w-80 max-w-[86vw] flex-col border-r border-gray-200 bg-gray-50/95 backdrop-blur transition-all duration-200 dark:border-gray-800 dark:bg-neutral-900/95 lg:relative lg:inset-auto lg:z-10 lg:max-w-none lg:shrink-0",
        sidebarOpen ? "translate-x-0" : "-translate-x-full",
        sidebarCollapsed
          ? "lg:w-0 lg:min-w-0 lg:-translate-x-full lg:overflow-hidden lg:border-r-0 lg:opacity-0 lg:pointer-events-none"
          : "lg:w-80 lg:translate-x-0 lg:opacity-100",
      ].join(" ")}
    >
      <div className="border-b border-gray-200 bg-white px-4 py-2 dark:border-gray-800 dark:bg-neutral-800">
        <div className="flex min-h-14 items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => navigateWithinShell({ view: "home" })}
            className="text-xs font-semibold uppercase tracking-[0.24em] text-gray-500 transition hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
          >
            Ralpher
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              aria-label="Reload page"
              title="Reload page"
              className={iconButtonDefault}
            >
              <RefreshIcon size="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => navigateWithinShell({ view: "code-explorer" })}
              aria-label="Open code explorer"
              aria-current={route.view === "code-explorer" ? "page" : undefined}
              className={route.view === "code-explorer" ? iconButtonActive : iconButtonDefault}
              title="Code explorer"
            >
              <CodeIcon size="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => navigateWithinShell({ view: "settings" })}
              aria-label="Open settings"
              aria-current={route.view === "settings" ? "page" : undefined}
              className={route.view === "settings" ? iconButtonActive : iconButtonDefault}
              title="Settings"
            >
              <GearIcon size="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={hideSidebar}
              aria-label={sidebarOpen ? "Close sidebar" : "Hide sidebar"}
              className={iconButtonDefault}
            >
              <SidebarIcon size="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto px-3 py-4 dark-scrollbar">
        <ShellSection
          title="Workspaces"
          count={workspaces.length}
          actionLabel="New"
          onAction={() => navigateWithinShell({ view: "compose", kind: "workspace" })}
          collapsed={isNodeCollapsed(workspacesCollapseKey)}
          onToggle={() => toggleNodeCollapsed(workspacesCollapseKey)}
        >
          {visibleWorkspaceGroups.map((group) => {
            const groupCollapseKey = getSidebarGroupCollapseKey("workspaces", group.key);
            return (
              <SidebarTreeSection
                key={group.key}
                title={group.title}
                count={group.workspaces.length}
                collapsed={isNodeCollapsed(groupCollapseKey)}
                onToggle={() => toggleNodeCollapsed(groupCollapseKey)}
              >
                {group.workspaces.map((workspaceNode) => {
                  const workspaceCollapseKey = getSidebarWorkspaceCollapseKey(
                    "workspaces",
                    group.key,
                    workspaceNode.workspace.id,
                  );
                  const loopsCollapseKey = getSidebarWorkspaceSectionCollapseKey(
                    "workspaces",
                    group.key,
                    workspaceNode.workspace.id,
                    "loops",
                  );
                  const chatsCollapseKey = getSidebarWorkspaceSectionCollapseKey(
                    "workspaces",
                    group.key,
                    workspaceNode.workspace.id,
                    "chats",
                  );
                  const historyCollapseKey = getSidebarWorkspaceSectionCollapseKey(
                    "workspaces",
                    group.key,
                    workspaceNode.workspace.id,
                    "history",
                  );
                  const sessionsCollapseKey = getSidebarWorkspaceSectionCollapseKey(
                    "workspaces",
                    group.key,
                    workspaceNode.workspace.id,
                    "ssh-sessions",
                  );
                  return (
                    <div key={`${group.key}:${workspaceNode.key}`} className="space-y-1">
                      <SidebarTreeItem
                        active={isWorkspaceActive(workspaceNode.workspace.id)}
                        title={workspaceNode.workspace.name}
                        subtitle={workspaceNode.workspace.directory}
                        indentLevel={1}
                        collapsed={isNodeCollapsed(workspaceCollapseKey)}
                        onToggle={() => toggleNodeCollapsed(workspaceCollapseKey)}
                        onClick={(event) => handleSidebarItemClick(event, {
                          view: "workspace",
                          workspaceId: workspaceNode.workspace.id,
                        })}
                      />
                      {!isNodeCollapsed(workspaceCollapseKey) && (
                        <div className="space-y-1">
                          <SidebarTreeSection
                            title="Loops"
                            count={workspaceNode.loops.length}
                            actionLabel="New"
                            onAction={() => navigateWithinShell({
                              view: "compose",
                              kind: "loop",
                              scopeId: workspaceNode.workspace.id,
                            })}
                            collapsed={isNodeCollapsed(loopsCollapseKey)}
                            onToggle={() => toggleNodeCollapsed(loopsCollapseKey)}
                            indentLevel={2}
                          >
                            {renderLoopNodes({
                              groupKey: group.key,
                              workspaceId: workspaceNode.workspace.id,
                              loopNodes: workspaceNode.loops,
                            })}
                          </SidebarTreeSection>

                          {workspaceNode.historyLoops.length > 0 && (
                            <SidebarTreeSection
                              title="History"
                              count={workspaceNode.historyLoops.length}
                              collapsed={isNodeCollapsed(historyCollapseKey)}
                              onToggle={() => toggleNodeCollapsed(historyCollapseKey)}
                              indentLevel={2}
                            >
                              {renderLoopNodes({
                                groupKey: group.key,
                                workspaceId: workspaceNode.workspace.id,
                                loopNodes: workspaceNode.historyLoops,
                              })}
                            </SidebarTreeSection>
                          )}

                          <SidebarTreeSection
                            title="Chats"
                            count={workspaceNode.chats.length}
                            actionLabel="New"
                            onAction={() => navigateWithinShell({
                              view: "compose",
                              kind: "chat",
                              scopeId: workspaceNode.workspace.id,
                            })}
                            collapsed={isNodeCollapsed(chatsCollapseKey)}
                            onToggle={() => toggleNodeCollapsed(chatsCollapseKey)}
                            indentLevel={2}
                          >
                            {workspaceNode.chats.map((chatNode) => (
                              <SidebarTreeItem
                                key={chatNode.chat.config.id}
                                active={isChatActive(chatNode.chat.config.id)}
                                title={chatNode.title}
                                badge={chatNode.badge}
                                badgeVariant={chatNode.badgeVariant}
                                indentLevel={3}
                                onClick={(event) => handleSidebarItemClick(event, {
                                  view: "chat",
                                  chatId: chatNode.chat.config.id,
                                })}
                              />
                            ))}
                          </SidebarTreeSection>

                          <SidebarTreeSection
                            title="SSH sessions"
                            count={workspaceNode.sshSessions.length}
                            actionLabel="New"
                            onAction={() => navigateWithinShell({
                              view: "compose",
                              kind: "ssh-session",
                              scopeId: workspaceNode.workspace.id,
                            })}
                            collapsed={isNodeCollapsed(sessionsCollapseKey)}
                            onToggle={() => toggleNodeCollapsed(sessionsCollapseKey)}
                            indentLevel={2}
                          >
                            {workspaceNode.sshSessions.map((sessionNode) => (
                              <SidebarTreeItem
                                key={sessionNode.session.config.id}
                                active={route.view === "ssh" && route.sshSessionId === sessionNode.session.config.id}
                                title={sessionNode.title}
                                subtitle={sessionNode.subtitle}
                                badge={sessionNode.badge}
                                badgeVariant={sessionNode.badgeVariant}
                                indentLevel={3}
                                onClick={(event) => handleSidebarItemClick(event, {
                                  view: "ssh",
                                  sshSessionId: sessionNode.session.config.id,
                                })}
                              />
                            ))}
                          </SidebarTreeSection>
                        </div>
                      )}
                    </div>
                  );
                })}
              </SidebarTreeSection>
            );
          })}
        </ShellSection>

        <ShellSection
          title="SSH servers"
          count={serverNodes.length}
          actionLabel="New"
          onAction={() => navigateWithinShell({ view: "compose", kind: "ssh-server" })}
          collapsed={isNodeCollapsed(serversCollapseKey)}
          onToggle={() => toggleNodeCollapsed(serversCollapseKey)}
        >
          {serverNodes.length === 0 ? (
            <EmptySection message="No standalone SSH servers registered." />
          ) : (
            serverNodes.map((serverNode) => {
              const serverCollapseKey = getSidebarServerCollapseKey("ssh-servers", serverNode.server.config.id);
              const sessionsCollapseKey = getSidebarServerSectionCollapseKey(
                "ssh-servers",
                serverNode.server.config.id,
                "sessions",
              );
              return (
                <div key={serverNode.key} className="space-y-1">
                  <SidebarTreeItem
                    active={isServerActive(serverNode.server.config.id)}
                    title={serverNode.server.config.name}
                    subtitle={`${serverNode.server.config.username}@${serverNode.server.config.address}`}
                    badge={serverNode.sessions.length > 0 ? String(serverNode.sessions.length) : undefined}
                    indentLevel={0}
                    collapsed={isNodeCollapsed(serverCollapseKey)}
                    onToggle={() => toggleNodeCollapsed(serverCollapseKey)}
                    onClick={(event) => handleSidebarItemClick(event, {
                      view: "ssh-server",
                      serverId: serverNode.server.config.id,
                    })}
                  />
                  {!isNodeCollapsed(serverCollapseKey) && (
                    <SidebarTreeSection
                      title="Sessions"
                      count={serverNode.sessions.length}
                      actionLabel="New"
                      onAction={() => navigateWithinShell({
                        view: "compose",
                        kind: "ssh-session",
                        scopeId: serverNode.server.config.id,
                      })}
                      collapsed={isNodeCollapsed(sessionsCollapseKey)}
                      onToggle={() => toggleNodeCollapsed(sessionsCollapseKey)}
                      indentLevel={1}
                    >
                      {serverNode.sessions.map((sessionNode) => (
                        <SidebarTreeItem
                          key={sessionNode.id}
                          active={route.view === "ssh" && route.sshSessionId === sessionNode.id}
                          title={sessionNode.title}
                          subtitle={sessionNode.subtitle}
                          badge={sessionNode.badge}
                          badgeVariant={sessionNode.badgeVariant}
                          indentLevel={2}
                          onClick={(event) => handleSidebarItemClick(event, {
                            view: "ssh",
                            sshSessionId: sessionNode.id,
                          })}
                        />
                      ))}
                    </SidebarTreeSection>
                  )}
                </div>
              );
            })
          )}
        </ShellSection>

        {version && (
          <div className="px-1 text-[11px] leading-4 text-gray-400 dark:text-gray-500">v{version}</div>
        )}
      </div>
    </aside>
  );
}
