import { useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { CodeIcon, GearIcon, RefreshIcon, SidebarIcon } from "../common";
import { getShellRouteUrl, isModifiedNavigationClick } from "./shell-navigation";
import { EmptySection, ShellSection, SidebarTreeItem, SidebarTreeSection } from "./shell-sidebar";
import {
  type SidebarChatNode,
  getSidebarGroupCollapseKey,
  getSidebarSectionCollapseKey,
  getSidebarServerCollapseKey,
  getSidebarServerSectionCollapseKey,
  getSidebarWorkspaceCollapseKey,
  getSidebarWorkspaceSectionCollapseKey,
  type SidebarServerSessionNode,
  type ShellRoute,
  type SidebarLoopNode,
  type SidebarServerNode,
  type SidebarWorkspaceNode,
  type SidebarWorkspaceGroupNode,
  type SidebarWorkspaceSessionNode,
} from "./shell-types";

interface ShellSidebarNavProps {
  route: ShellRoute;
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  navigateWithinShell: (route: ShellRoute) => void;
  hideSidebar: () => void;
  isNodeCollapsed: (collapseKey: string) => boolean;
  toggleNodeCollapsed: (collapseKey: string) => void;
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
const searchInputClassName =
  "block w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 shadow-sm outline-none transition focus:border-gray-500 focus:ring-2 focus:ring-gray-300 dark:border-gray-700 dark:bg-neutral-800 dark:text-gray-100 dark:focus:border-gray-500 dark:focus:ring-gray-700";

interface SidebarLoopSearchResult {
  key: string;
  workspaceName: string;
  loopNode: SidebarLoopNode;
}

interface SidebarChatSearchResult {
  key: string;
  workspaceName: string;
  chatNode: SidebarChatNode;
}

interface SidebarSessionSearchResult {
  key: string;
  contextName: string;
  sessionNode: SidebarWorkspaceSessionNode | SidebarServerSessionNode;
}

interface SidebarSearchResults {
  workspaces: SidebarWorkspaceNode[];
  loops: SidebarLoopSearchResult[];
  chats: SidebarChatSearchResult[];
  sshSessions: SidebarSessionSearchResult[];
  sshServers: SidebarServerNode[];
}

function matchesSearchText(label: string, query: string): boolean {
  return query.length > 0 && label.toLowerCase().includes(query);
}

function getSidebarSessionId(sessionNode: SidebarWorkspaceSessionNode | SidebarServerSessionNode): string {
  return "session" in sessionNode ? sessionNode.session.config.id : sessionNode.id;
}

function SearchResultsSection({
  title,
  bordered = false,
  children,
}: {
  title: string;
  bordered?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={bordered ? "border-t border-gray-200 pt-4 dark:border-gray-800" : ""}>
      <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">
        {title}
      </h2>
      <div className="mt-2 space-y-2">
        {children}
      </div>
    </section>
  );
}

export function ShellSidebarNav({
  route,
  sidebarOpen,
  sidebarCollapsed,
  navigateWithinShell,
  hideSidebar,
  isNodeCollapsed,
  toggleNodeCollapsed,
  workspaceGroups,
  serverNodes,
  version,
}: ShellSidebarNavProps) {
  const [searchInput, setSearchInput] = useState("");
  const searchQuery = searchInput.trim().toLowerCase();

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
    loopNodes,
    indentLevel = 3,
  }: {
    loopNodes: SidebarLoopNode[];
    indentLevel?: number;
  }) {
    return loopNodes.map((loopNode) => (
      <SidebarTreeItem
        key={loopNode.loop.config.id}
        active={isLoopActive(loopNode.loop.config.id)}
        title={loopNode.title}
        badge={loopNode.badge}
        badgeVariant={loopNode.badgeVariant}
        indentLevel={indentLevel}
        onClick={(event) => handleSidebarItemClick(event, {
          view: "loop",
          loopId: loopNode.loop.config.id,
        })}
      />
    ));
  }

  const workspacesCollapseKey = getSidebarSectionCollapseKey("workspaces");
  const serversCollapseKey = getSidebarSectionCollapseKey("ssh-servers");
  const visibleWorkspaceGroups = workspaceGroups.filter((group) => group.workspaces.length > 0);
  const searchResults = useMemo<SidebarSearchResults | null>(() => {
    if (!searchQuery) {
      return null;
    }

    const results: SidebarSearchResults = {
      workspaces: [],
      loops: [],
      chats: [],
      sshSessions: [],
      sshServers: [],
    };
    const seenWorkspaceIds = new Set<string>();
    const seenLoopIds = new Set<string>();
    const seenChatIds = new Set<string>();
    const seenSessionIds = new Set<string>();
    const seenServerIds = new Set<string>();

    const matchesWorkspacesSection = matchesSearchText("Workspaces", searchQuery);
    const matchesLoopsSection = matchesSearchText("Loops", searchQuery);
    const matchesChatsSection = matchesSearchText("Chats", searchQuery);
    const matchesSshSessionsSection = matchesSearchText("SSH sessions", searchQuery);
    const matchesHistorySection = matchesSearchText("History", searchQuery);
    const matchesSshServersSection = matchesSearchText("SSH servers", searchQuery);
    const matchesServerSessionsSection = matchesSearchText("Sessions", searchQuery);

    for (const group of workspaceGroups) {
      const matchesGroup = matchesSearchText(group.title, searchQuery);

      for (const workspaceNode of group.workspaces) {
        const workspaceId = workspaceNode.workspace.id;
        const matchesWorkspace = matchesSearchText(workspaceNode.workspace.name, searchQuery);
        if ((matchesWorkspacesSection || matchesGroup || matchesWorkspace) && !seenWorkspaceIds.has(workspaceId)) {
          seenWorkspaceIds.add(workspaceId);
          results.workspaces.push(workspaceNode);
        }

        for (const loopNode of workspaceNode.loops) {
          const loopId = loopNode.loop.config.id;
          if ((matchesLoopsSection || matchesSearchText(loopNode.title, searchQuery)) && !seenLoopIds.has(loopId)) {
            seenLoopIds.add(loopId);
            results.loops.push({
              key: loopId,
              workspaceName: workspaceNode.workspace.name,
              loopNode,
            });
          }
        }

        for (const loopNode of workspaceNode.historyLoops) {
          const loopId = loopNode.loop.config.id;
          if ((matchesLoopsSection || matchesHistorySection || matchesSearchText(loopNode.title, searchQuery))
            && !seenLoopIds.has(loopId)) {
            seenLoopIds.add(loopId);
            results.loops.push({
              key: loopId,
              workspaceName: workspaceNode.workspace.name,
              loopNode,
            });
          }
        }

        for (const chatNode of workspaceNode.chats) {
          const chatId = chatNode.chat.config.id;
          if ((matchesChatsSection || matchesSearchText(chatNode.title, searchQuery)) && !seenChatIds.has(chatId)) {
            seenChatIds.add(chatId);
            results.chats.push({
              key: chatId,
              workspaceName: workspaceNode.workspace.name,
              chatNode,
            });
          }
        }

        for (const sessionNode of workspaceNode.sshSessions) {
          const sessionId = sessionNode.session.config.id;
          if ((matchesSshSessionsSection || matchesSearchText(sessionNode.title, searchQuery))
            && !seenSessionIds.has(sessionId)) {
            seenSessionIds.add(sessionId);
            results.sshSessions.push({
              key: sessionId,
              contextName: workspaceNode.workspace.name,
              sessionNode,
            });
          }
        }
      }
    }

    for (const serverNode of serverNodes) {
      const serverId = serverNode.server.config.id;
      const matchesServer = matchesSearchText(serverNode.server.config.name, searchQuery);
      if ((matchesSshServersSection || matchesServer) && !seenServerIds.has(serverId)) {
        seenServerIds.add(serverId);
        results.sshServers.push(serverNode);
      }

      for (const sessionNode of serverNode.sessions) {
        const sessionId = sessionNode.id;
        if ((matchesSshSessionsSection || matchesServerSessionsSection || matchesSearchText(sessionNode.title, searchQuery))
          && !seenSessionIds.has(sessionId)) {
          seenSessionIds.add(sessionId);
          results.sshSessions.push({
            key: sessionId,
            contextName: serverNode.server.config.name,
            sessionNode,
          });
        }
      }
    }

    return results;
  }, [searchQuery, serverNodes, workspaceGroups]);
  const isSearching = searchResults !== null;
  const hasSearchResults = (searchResults?.workspaces.length ?? 0) > 0
    || (searchResults?.loops.length ?? 0) > 0
    || (searchResults?.chats.length ?? 0) > 0
    || (searchResults?.sshSessions.length ?? 0) > 0
    || (searchResults?.sshServers.length ?? 0) > 0;

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
        <div>
          <label htmlFor="shell-sidebar-search" className="sr-only">
            Search sidebar
          </label>
          <input
            id="shell-sidebar-search"
            type="text"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search sidebar"
            className={searchInputClassName}
          />
        </div>

        {isSearching ? (
          hasSearchResults ? (
            <div className="space-y-4">
              {searchResults.workspaces.length > 0 && (
                <SearchResultsSection title="Workspaces">
                  {searchResults.workspaces.map((workspaceNode) => (
                    <div key={`search-workspace:${workspaceNode.workspace.id}`} className="space-y-1">
                      <SidebarTreeItem
                        active={isWorkspaceActive(workspaceNode.workspace.id)}
                        title={workspaceNode.workspace.name}
                        subtitle={workspaceNode.workspace.directory}
                        onClick={(event) => handleSidebarItemClick(event, {
                          view: "workspace",
                          workspaceId: workspaceNode.workspace.id,
                        })}
                      />
                      {(workspaceNode.loops.length > 0 || workspaceNode.historyLoops.length > 0) && (
                        <SidebarTreeSection title="Loops" indentLevel={1}>
                          {workspaceNode.loops.length > 0 && renderLoopNodes({
                            loopNodes: workspaceNode.loops,
                            indentLevel: 2,
                          })}
                          {workspaceNode.historyLoops.length > 0 && (
                            <SidebarTreeSection title="History" indentLevel={2}>
                              {renderLoopNodes({
                                loopNodes: workspaceNode.historyLoops,
                                indentLevel: 3,
                              })}
                            </SidebarTreeSection>
                          )}
                        </SidebarTreeSection>
                      )}
                      {workspaceNode.chats.length > 0 && (
                        <SidebarTreeSection title="Chats" indentLevel={1}>
                          {workspaceNode.chats.map((chatNode) => (
                            <SidebarTreeItem
                              key={chatNode.chat.config.id}
                              active={isChatActive(chatNode.chat.config.id)}
                              title={chatNode.title}
                              badge={chatNode.badge}
                              badgeVariant={chatNode.badgeVariant}
                              indentLevel={2}
                              onClick={(event) => handleSidebarItemClick(event, {
                                view: "chat",
                                chatId: chatNode.chat.config.id,
                              })}
                            />
                          ))}
                        </SidebarTreeSection>
                      )}
                      {workspaceNode.sshSessions.length > 0 && (
                        <SidebarTreeSection title="SSH sessions" indentLevel={1}>
                          {workspaceNode.sshSessions.map((sessionNode) => (
                            <SidebarTreeItem
                              key={sessionNode.session.config.id}
                              active={route.view === "ssh" && route.sshSessionId === sessionNode.session.config.id}
                              title={sessionNode.title}
                              subtitle={sessionNode.subtitle}
                              badge={sessionNode.badge}
                              badgeVariant={sessionNode.badgeVariant}
                              indentLevel={2}
                              onClick={(event) => handleSidebarItemClick(event, {
                                view: "ssh",
                                sshSessionId: sessionNode.session.config.id,
                              })}
                            />
                          ))}
                        </SidebarTreeSection>
                      )}
                    </div>
                  ))}
                </SearchResultsSection>
              )}

              {searchResults.loops.length > 0 && (
                <SearchResultsSection title="Loops" bordered={searchResults.workspaces.length > 0}>
                  {searchResults.loops.map(({ key, workspaceName, loopNode }) => (
                    <SidebarTreeItem
                      key={`search-loop:${key}`}
                      active={isLoopActive(loopNode.loop.config.id)}
                      title={loopNode.title}
                      subtitle={workspaceName}
                      badge={loopNode.badge}
                      badgeVariant={loopNode.badgeVariant}
                      onClick={(event) => handleSidebarItemClick(event, {
                        view: "loop",
                        loopId: loopNode.loop.config.id,
                      })}
                    />
                  ))}
                </SearchResultsSection>
              )}

              {searchResults.chats.length > 0 && (
                <SearchResultsSection
                  title="Chats"
                  bordered={searchResults.workspaces.length > 0 || searchResults.loops.length > 0}
                >
                  {searchResults.chats.map(({ key, workspaceName, chatNode }) => (
                    <SidebarTreeItem
                      key={`search-chat:${key}`}
                      active={isChatActive(chatNode.chat.config.id)}
                      title={chatNode.title}
                      subtitle={workspaceName}
                      badge={chatNode.badge}
                      badgeVariant={chatNode.badgeVariant}
                      onClick={(event) => handleSidebarItemClick(event, {
                        view: "chat",
                        chatId: chatNode.chat.config.id,
                      })}
                    />
                  ))}
                </SearchResultsSection>
              )}

              {searchResults.sshSessions.length > 0 && (
                <SearchResultsSection
                  title="SSH sessions"
                  bordered={searchResults.workspaces.length > 0
                    || searchResults.loops.length > 0
                    || searchResults.chats.length > 0}
                >
                  {searchResults.sshSessions.map(({ key, contextName, sessionNode }) => {
                    const sessionId = getSidebarSessionId(sessionNode);
                    return (
                      <SidebarTreeItem
                        key={`search-session:${key}`}
                        active={route.view === "ssh" && route.sshSessionId === sessionId}
                        title={sessionNode.title}
                        subtitle={`${contextName} · ${sessionNode.subtitle}`}
                        badge={sessionNode.badge}
                        badgeVariant={sessionNode.badgeVariant}
                        onClick={(event) => handleSidebarItemClick(event, {
                          view: "ssh",
                          sshSessionId: sessionId,
                        })}
                      />
                    );
                  })}
                </SearchResultsSection>
              )}

              {searchResults.sshServers.length > 0 && (
                <SearchResultsSection
                  title="SSH servers"
                  bordered={searchResults.workspaces.length > 0
                    || searchResults.loops.length > 0
                    || searchResults.chats.length > 0
                    || searchResults.sshSessions.length > 0}
                >
                  {searchResults.sshServers.map((serverNode) => (
                    <div key={`search-server:${serverNode.server.config.id}`} className="space-y-1">
                      <SidebarTreeItem
                        active={isServerActive(serverNode.server.config.id)}
                        title={serverNode.server.config.name}
                        subtitle={`${serverNode.server.config.username}@${serverNode.server.config.address}`}
                        onClick={(event) => handleSidebarItemClick(event, {
                          view: "ssh-server",
                          serverId: serverNode.server.config.id,
                        })}
                      />
                      {serverNode.sessions.length > 0 && (
                        <SidebarTreeSection title="Sessions" indentLevel={1}>
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
                  ))}
                </SearchResultsSection>
              )}
            </div>
          ) : (
            <EmptySection message="No sidebar items match that search." />
          )
        ) : (
          <>
            <ShellSection
              title="Workspaces"
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
                    collapsed={isNodeCollapsed(groupCollapseKey)}
                    onToggle={() => toggleNodeCollapsed(groupCollapseKey)}
                  >
                    {group.workspaces.map((workspaceNode) => {
                      const hasLoopChildren = workspaceNode.loops.length > 0 || workspaceNode.historyLoops.length > 0;
                      const hasChatChildren = workspaceNode.chats.length > 0;
                      const hasSessionChildren = workspaceNode.sshSessions.length > 0;
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
                                actionLabel="New"
                                onAction={() => navigateWithinShell({
                                  view: "compose",
                                  kind: "loop",
                                  scopeId: workspaceNode.workspace.id,
                                })}
                                collapsed={hasLoopChildren ? isNodeCollapsed(loopsCollapseKey) : undefined}
                                onToggle={hasLoopChildren ? () => toggleNodeCollapsed(loopsCollapseKey) : undefined}
                                indentLevel={2}
                              >
                                {workspaceNode.loops.length > 0 && renderLoopNodes({
                                  loopNodes: workspaceNode.loops,
                                })}
                                {workspaceNode.historyLoops.length > 0 && (
                                  <SidebarTreeSection
                                    title="History"
                                    collapsed={isNodeCollapsed(historyCollapseKey)}
                                    onToggle={() => toggleNodeCollapsed(historyCollapseKey)}
                                    indentLevel={3}
                                  >
                                    {renderLoopNodes({
                                      loopNodes: workspaceNode.historyLoops,
                                    })}
                                  </SidebarTreeSection>
                                )}
                              </SidebarTreeSection>

                              <SidebarTreeSection
                                title="Chats"
                                actionLabel="New"
                                onAction={() => navigateWithinShell({
                                  view: "compose",
                                  kind: "chat",
                                  scopeId: workspaceNode.workspace.id,
                                })}
                                collapsed={hasChatChildren ? isNodeCollapsed(chatsCollapseKey) : undefined}
                                onToggle={hasChatChildren ? () => toggleNodeCollapsed(chatsCollapseKey) : undefined}
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
                                actionLabel="New"
                                onAction={() => navigateWithinShell({
                                  view: "compose",
                                  kind: "ssh-session",
                                  scopeId: workspaceNode.workspace.id,
                                })}
                                collapsed={hasSessionChildren ? isNodeCollapsed(sessionsCollapseKey) : undefined}
                                onToggle={hasSessionChildren ? () => toggleNodeCollapsed(sessionsCollapseKey) : undefined}
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
                          indentLevel={1}
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
                          actionLabel="New"
                          onAction={() => navigateWithinShell({
                            view: "compose",
                            kind: "ssh-session",
                            scopeId: serverNode.server.config.id,
                          })}
                          collapsed={serverNode.sessions.length > 0 ? isNodeCollapsed(sessionsCollapseKey) : undefined}
                          onToggle={serverNode.sessions.length > 0 ? () => toggleNodeCollapsed(sessionsCollapseKey) : undefined}
                          indentLevel={2}
                        >
                          {serverNode.sessions.map((sessionNode) => (
                            <SidebarTreeItem
                              key={sessionNode.id}
                              active={route.view === "ssh" && route.sshSessionId === sessionNode.id}
                              title={sessionNode.title}
                              subtitle={sessionNode.subtitle}
                              badge={sessionNode.badge}
                              badgeVariant={sessionNode.badgeVariant}
                              indentLevel={3}
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
          </>
        )}

        {version && (
          <div className="px-1 text-[11px] leading-4 text-gray-400 dark:text-gray-500">v{version}</div>
        )}
      </div>
    </aside>
  );
}
