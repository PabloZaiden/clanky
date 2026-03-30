import type { Chat, Loop, Workspace } from "../../types";
import type { SshServer, SshServerSession } from "../../types/ssh-server";
import { getLoopStatusLabel } from "../../utils";
import { GearIcon, RefreshIcon, SidebarIcon, getLoopStatusBadgeVariant, getStatusBadgeVariant } from "../common";
import type { BadgeVariant } from "../common";
import { ShellSection, SectionItem, WorkspaceGroupedSectionItems, EmptySection } from "./shell-sidebar";
import type { ShellRoute, SidebarSectionId, WorkspaceSidebarGroup } from "./shell-types";

export interface ShellSession {
  id: string;
  title: string;
  subtitle: string;
  badge: string;
  badgeVariant: BadgeVariant;
  createdAt: string;
}

interface ShellSidebarNavProps {
  route: ShellRoute;
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  navigateWithinShell: (route: ShellRoute) => void;
  hideSidebar: () => void;
  isSectionCollapsed: (sectionId: SidebarSectionId) => boolean;
  toggleSectionCollapsed: (sectionId: SidebarSectionId) => void;
  toggleWorkspaceGroupCollapsed: (sectionId: SidebarSectionId, groupKey: string) => void;
  collapsedWorkspaceGroups: Partial<Record<string, boolean>>;
  workspaces: Workspace[];
  loopGroups: WorkspaceSidebarGroup[];
  loopItems: Loop[];
  chatItems: Array<{ chat: Chat; workspaceName: string }>;
  allShellSessions: ShellSession[];
  servers: SshServer[];
  sessionsByServerId: Record<string, SshServerSession[]>;
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
  isSectionCollapsed,
  toggleSectionCollapsed,
  toggleWorkspaceGroupCollapsed,
  collapsedWorkspaceGroups,
  workspaces,
  loopGroups,
  loopItems,
  chatItems,
  allShellSessions,
  servers,
  sessionsByServerId,
  version,
}: ShellSidebarNavProps) {
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
          collapsed={isSectionCollapsed("workspaces")}
          onToggle={() => toggleSectionCollapsed("workspaces")}
        >
          {workspaces.length === 0 ? (
            <EmptySection message="No workspaces yet." />
          ) : (
            workspaces.map((workspace) => (
              <SectionItem
                key={workspace.id}
                active={
                  (route.view === "workspace" || route.view === "workspace-settings") &&
                  route.workspaceId === workspace.id
                }
                title={workspace.name}
                subtitle={workspace.directory}
                onClick={() => navigateWithinShell({ view: "workspace", workspaceId: workspace.id })}
              />
            ))
          )}
        </ShellSection>

        <ShellSection
          title="Loops"
          count={loopItems.length}
          actionLabel="New"
          onAction={() => navigateWithinShell({ view: "compose", kind: "loop" })}
          collapsed={isSectionCollapsed("loops")}
          onToggle={() => toggleSectionCollapsed("loops")}
        >
          {loopItems.length === 0 ? (
            <EmptySection message="No loops yet." />
          ) : (
            <WorkspaceGroupedSectionItems
              sectionId="loops"
              groups={loopGroups}
              collapsedGroups={collapsedWorkspaceGroups}
              onToggleGroup={toggleWorkspaceGroupCollapsed}
              renderItem={(loop) => (
                <SectionItem
                  key={loop.config.id}
                  active={route.view === "loop" && route.loopId === loop.config.id}
                  title={loop.config.name}
                  badge={getLoopStatusLabel(loop)}
                  badgeVariant={getLoopStatusBadgeVariant(
                    loop.state.status,
                    loop.state.planMode?.isPlanReady ?? false,
                  )}
                  onClick={() => navigateWithinShell({ view: "loop", loopId: loop.config.id })}
                />
              )}
            />
          )}
        </ShellSection>

        <ShellSection
          title="Chats"
          count={chatItems.length}
          actionLabel="New"
          onAction={() => navigateWithinShell({ view: "compose", kind: "chat" })}
          collapsed={isSectionCollapsed("chats")}
          onToggle={() => toggleSectionCollapsed("chats")}
        >
          {chatItems.length === 0 ? (
            <EmptySection message="No chats yet." />
          ) : (
            chatItems.map(({ chat, workspaceName }) => (
              <SectionItem
                key={chat.config.id}
                active={route.view === "chat" && route.chatId === chat.config.id}
                title={chat.config.name}
                subtitle={workspaceName}
                badge={chat.state.status}
                badgeVariant={getStatusBadgeVariant(chat.state.status)}
                onClick={() => navigateWithinShell({ view: "chat", chatId: chat.config.id })}
              />
            ))
          )}
        </ShellSection>

        <ShellSection
          title="SSH Sessions"
          count={allShellSessions.length}
          actionLabel="New"
          onAction={() => navigateWithinShell({ view: "compose", kind: "ssh-session" })}
          collapsed={isSectionCollapsed("workspace-ssh")}
          onToggle={() => toggleSectionCollapsed("workspace-ssh")}
        >
          {allShellSessions.length === 0 ? (
            <EmptySection message="No SSH sessions yet." />
          ) : (
            allShellSessions.map((session) => (
              <SectionItem
                key={session.id}
                active={route.view === "ssh" && route.sshSessionId === session.id}
                title={session.title}
                subtitle={session.subtitle}
                badge={session.badge}
                badgeVariant={session.badgeVariant}
                onClick={() => navigateWithinShell({ view: "ssh", sshSessionId: session.id })}
              />
            ))
          )}
        </ShellSection>

        <ShellSection
          title="SSH servers"
          count={servers.length}
          actionLabel="New"
          onAction={() => navigateWithinShell({ view: "compose", kind: "ssh-server" })}
          collapsed={isSectionCollapsed("ssh-servers")}
          onToggle={() => toggleSectionCollapsed("ssh-servers")}
        >
          {servers.length === 0 ? (
            <EmptySection message="No standalone SSH servers registered." />
          ) : (
            servers.map((server) => {
              const serverSessions = sessionsByServerId[server.config.id] ?? [];
              return (
                <SectionItem
                  key={server.config.id}
                  active={route.view === "ssh-server" && route.serverId === server.config.id}
                  title={server.config.name}
                  subtitle={`${server.config.username}@${server.config.address}`}
                  badge={serverSessions.length > 0 ? String(serverSessions.length) : undefined}
                  onClick={() => navigateWithinShell({ view: "ssh-server", serverId: server.config.id })}
                />
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
