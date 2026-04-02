import { useMemo } from "react";
import {
  useChats,
  useDashboardData,
  useLoopGrouping,
  useLoops,
  useProvisioningJob,
  useSshServers,
  useSshSessions,
  useToast,
  useWorkspaces,
} from "../../hooks";
import { getSshSessionStatusBadgeVariant } from "../common";
import { getSshConnectionModeLabel, groupSidebarChatsByWorkspace, groupSidebarItemsByWorkspace } from "./shell-types";
import { ShellSidebarNav } from "./shell-sidebar-nav";
import { ShellMainContent } from "./shell-main-content";
import { useSidebar } from "./use-sidebar";
import { useWorkspaceCreate } from "./use-workspace-create";
import { useWorkspaceSettingsShell } from "./use-workspace-settings-shell";
import { useComposeState } from "./use-compose-state";

export type { ShellRoute } from "./shell-types";

interface AppShellProps {
  route: import("./shell-types").ShellRoute;
  onNavigate: (route: import("./shell-types").ShellRoute) => void;
}

export function AppShell({ route, onNavigate }: AppShellProps) {
  const toast = useToast();
  const {
    chats,
    loading: chatsLoading,
    error: chatsError,
    refresh: refreshChats,
    createChat,
  } = useChats();
  const {
    loops,
    loading: loopsLoading,
    error: loopsError,
    refresh: refreshLoops,
    createLoop,
    purgeLoop,
    purgeArchivedWorkspaceLoops,
  } = useLoops();
  const {
    sessions,
    loading: sshSessionsLoading,
    error: sshSessionsError,
    refresh: refreshSshSessions,
    createSession,
  } = useSshSessions();
  const {
    servers,
    sessionsByServerId,
    loading: sshServersLoading,
    error: sshServersError,
    refresh: refreshSshServers,
    createServer,
    updateServer,
    deleteServer,
    createSession: createStandaloneSession,
  } = useSshServers();
  const {
    workspaces,
    loading: workspacesLoading,
    saving: workspacesSaving,
    error: workspaceError,
    refresh: refreshWorkspaces,
    createWorkspace,
    deleteWorkspace,
    exportConfig,
    importConfig,
  } = useWorkspaces();
  const dashboardData = useDashboardData();
  const provisioning = useProvisioningJob();
  const { workspaceGroups } = useLoopGrouping(loops, workspaces);

  const sidebar = useSidebar(route, onNavigate);
  const { navigateWithinShell } = sidebar;

  const workspaceCreate = useWorkspaceCreate({
    route,
    servers,
    provisioning,
    createWorkspace,
    refreshWorkspaces,
    toast,
    navigateWithinShell,
  });

  const workspaceSettings = useWorkspaceSettingsShell({
    route,
    workspaceGroups,
    purgeArchivedWorkspaceLoops,
  });

  const composeState = useComposeState({
    route,
    createLoop,
    refreshLoops,
    navigateWithinShell,
    dashboardData,
    toast,
  });

  // Derived memos
  const workspacesById = useMemo(() => new Map(workspaces.map((w) => [w.id, w])), [workspaces]);
  const serversById = useMemo(() => new Map(servers.map((s) => [s.config.id, s])), [servers]);
  const loopItems = loops;
  const standaloneSessions = useMemo(() => Object.values(sessionsByServerId).flat(), [sessionsByServerId]);
  const loopGroups = useMemo(
    () => groupSidebarItemsByWorkspace(loopItems, workspaces),
    [loopItems, workspaces],
  );
  const chatGroups = useMemo(
    () => groupSidebarChatsByWorkspace(chats, workspaces),
    [chats, workspaces],
  );
  const chatItems = useMemo(
    () =>
      chatGroups.flatMap((group) =>
        group.items.map((chat) => ({
          chat,
          workspaceName: group.title,
        })),
      ),
    [chatGroups],
  );
  const allShellSessions = useMemo(
    () =>
      [
        ...sessions.map((session) => ({
          id: session.config.id,
          title: session.config.name,
          subtitle: `${workspacesById.get(session.config.workspaceId)?.name ?? "Unknown workspace"} · ${getSshConnectionModeLabel(session.config.connectionMode)}`,
          badge: session.state.status,
          badgeVariant: getSshSessionStatusBadgeVariant(session.state.status),
          createdAt: session.config.createdAt,
        })),
        ...standaloneSessions.map((session) => ({
          id: session.config.id,
          title: session.config.name,
          subtitle: `${serversById.get(session.config.sshServerId)?.config.name ?? "Unknown server"} · ${getSshConnectionModeLabel(session.config.connectionMode)}`,
          badge: session.state.status,
          badgeVariant: getSshSessionStatusBadgeVariant(session.state.status),
          createdAt: session.config.createdAt,
        })),
      ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [serversById, sessions, standaloneSessions, workspacesById],
  );

  const shellLoading = chatsLoading || loopsLoading || sshSessionsLoading || sshServersLoading || workspacesLoading;
  const shellErrors = [chatsError, loopsError, sshSessionsError, sshServersError, workspaceError].filter(
    Boolean,
  ) as string[];

  const selectedLoop =
    route.view === "loop" ? (loops.find((loop) => loop.config.id === route.loopId) ?? null) : null;
  const selectedChat =
    route.view === "chat" ? (chats.find((chat) => chat.config.id === route.chatId) ?? null) : null;
  const selectedWorkspace =
     route.view === "workspace"
      || route.view === "workspace-files"
      || route.view === "workspace-settings"
      || route.view === "rebuild-workspace"
      || route.view === "restart-workspace"
      ? (workspaces.find((w) => w.id === route.workspaceId) ?? null)
      : null;
  const composeWorkspace =
    route.view === "compose" && route.kind !== "ssh-server" && route.scopeId
      ? (workspaces.find((w) => w.id === route.scopeId) ?? null)
      : null;
  const composeServer =
    route.view === "compose" && (route.kind === "ssh-session" || route.kind === "ssh-server") && route.scopeId
      ? (servers.find((s) => s.config.id === route.scopeId) ?? null)
      : null;
  const composeServerSessionCount = composeServer
    ? (sessionsByServerId[composeServer.config.id]?.length ?? 0)
    : 0;
  const selectedServer =
    route.view === "ssh-server" || route.view === "server-files" || route.view === "server-arise"
      ? (servers.find((s) => s.config.id === route.serverId) ?? null)
      : null;

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-gray-100 text-gray-950 dark:bg-neutral-950 dark:text-gray-100">
      <div
        className={[
          "fixed inset-0 z-30 bg-neutral-950/50 transition lg:hidden",
          sidebar.sidebarOpen ? "opacity-100" : "pointer-events-none opacity-0",
        ].join(" ")}
        onClick={sidebar.hideSidebar}
      />

      <ShellSidebarNav
        route={route}
        sidebarOpen={sidebar.sidebarOpen}
        sidebarCollapsed={sidebar.sidebarCollapsed}
        navigateWithinShell={navigateWithinShell}
        hideSidebar={sidebar.hideSidebar}
        isSectionCollapsed={sidebar.isSectionCollapsed}
        toggleSectionCollapsed={sidebar.toggleSectionCollapsed}
        toggleWorkspaceGroupCollapsed={sidebar.toggleWorkspaceGroupCollapsed}
        collapsedWorkspaceGroups={sidebar.collapsedWorkspaceGroups}
        workspaces={workspaces}
        loopGroups={loopGroups}
        loopItems={loopItems}
        chatItems={chatItems}
        allShellSessions={allShellSessions}
        servers={servers}
        sessionsByServerId={sessionsByServerId}
        version={dashboardData.version ?? undefined}
      />

      <ShellMainContent
        route={route}
        shellLoading={shellLoading}
        shellErrors={shellErrors}
        sidebarCollapsed={sidebar.sidebarCollapsed}
        shellHeaderOffsetClassName={sidebar.shellHeaderOffsetClassName}
        openSidebar={sidebar.openSidebar}
        navigateWithinShell={navigateWithinShell}
        loops={loops}
        chats={chats}
        workspaces={workspaces}
        sessions={sessions}
        servers={servers}
        sessionsByServerId={sessionsByServerId}
        workspaceGroups={workspaceGroups}
        workspacesLoading={workspacesLoading}
        workspacesSaving={workspacesSaving}
        workspaceError={workspaceError}
        selectedLoop={selectedLoop}
        selectedChat={selectedChat}
        selectedWorkspace={selectedWorkspace}
        composeWorkspace={composeWorkspace}
        composeServer={composeServer}
        composeServerSessionCount={composeServerSessionCount}
        selectedServer={selectedServer}
        refreshLoops={refreshLoops}
        refreshChats={refreshChats}
        purgeLoop={purgeLoop}
        refreshSshSessions={refreshSshSessions}
        refreshSshServers={refreshSshServers}
        refreshWorkspaces={refreshWorkspaces}
        createSession={createSession}
        createStandaloneSession={createStandaloneSession}
        createServer={createServer}
        updateServer={updateServer}
        deleteServer={deleteServer}
        deleteWorkspace={deleteWorkspace}
        exportConfig={exportConfig}
        importConfig={importConfig}
        dashboardData={dashboardData}
        composeActionState={composeState.composeActionState}
        setComposeActionState={composeState.setComposeActionState}
        handleLoopSubmit={composeState.handleLoopSubmit}
        createChat={createChat}
        workspaceCreate={workspaceCreate}
        workspaceSettings={workspaceSettings}
        provisioning={provisioning}
        toast={toast}
      />
    </div>
  );
}

export default AppShell;
