import { useMemo } from "react";
import {
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
import { getSshConnectionModeLabel } from "./shell-types";
import { groupSidebarItemsByWorkspace } from "./shell-types";
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
    loops,
    loading: loopsLoading,
    error: loopsError,
    refresh: refreshLoops,
    createLoop,
    createChat,
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
    createChat,
    refreshLoops,
    navigateWithinShell,
    dashboardData,
    toast,
  });

  // Derived memos
  const workspacesById = useMemo(() => new Map(workspaces.map((w) => [w.id, w])), [workspaces]);
  const serversById = useMemo(() => new Map(servers.map((s) => [s.config.id, s])), [servers]);
  const loopItems = useMemo(() => loops.filter((loop) => loop.config.mode !== "chat"), [loops]);
  const chatItems = useMemo(() => loops.filter((loop) => loop.config.mode === "chat"), [loops]);
  const standaloneSessions = useMemo(() => Object.values(sessionsByServerId).flat(), [sessionsByServerId]);
  const loopGroups = useMemo(
    () => groupSidebarItemsByWorkspace(loopItems, workspaces),
    [loopItems, workspaces],
  );
  const chatGroups = useMemo(
    () => groupSidebarItemsByWorkspace(chatItems, workspaces),
    [chatItems, workspaces],
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

  const shellLoading = loopsLoading || sshSessionsLoading || sshServersLoading || workspacesLoading;
  const shellErrors = [loopsError, sshSessionsError, sshServersError, workspaceError].filter(
    Boolean,
  ) as string[];

  const selectedLoop =
    route.view === "loop" ? (loopItems.find((loop) => loop.config.id === route.loopId) ?? null) : null;
  const selectedWorkspace =
    route.view === "workspace"
      || route.view === "workspace-settings"
      || route.view === "rebuild-workspace"
      || route.view === "restart-workspace"
      ? (workspaces.find((w) => w.id === route.workspaceId) ?? null)
      : null;
  const composeWorkspace =
    route.view === "compose" && route.scopeId
      ? (workspaces.find((w) => w.id === route.scopeId) ?? null)
      : null;
  const composeServer =
    route.view === "compose" && route.kind === "ssh-session" && route.scopeId
      ? (servers.find((s) => s.config.id === route.scopeId) ?? null)
      : null;
  const selectedServer =
    route.view === "ssh-server" ? (servers.find((s) => s.config.id === route.serverId) ?? null) : null;

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
        chatGroups={chatGroups}
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
        workspaces={workspaces}
        sessions={sessions}
        servers={servers}
        sessionsByServerId={sessionsByServerId}
        workspaceGroups={workspaceGroups}
        workspacesLoading={workspacesLoading}
        workspacesSaving={workspacesSaving}
        workspaceError={workspaceError}
        selectedLoop={selectedLoop}
        selectedWorkspace={selectedWorkspace}
        composeWorkspace={composeWorkspace}
        composeServer={composeServer}
        selectedServer={selectedServer}
        refreshLoops={refreshLoops}
        purgeLoop={purgeLoop}
        refreshSshSessions={refreshSshSessions}
        refreshSshServers={refreshSshServers}
        refreshWorkspaces={refreshWorkspaces}
        createSession={createSession}
        createStandaloneSession={createStandaloneSession}
        createServer={createServer}
        deleteServer={deleteServer}
        deleteWorkspace={deleteWorkspace}
        exportConfig={exportConfig}
        importConfig={importConfig}
        dashboardData={dashboardData}
        composeActionState={composeState.composeActionState}
        setComposeActionState={composeState.setComposeActionState}
        handleLoopSubmit={composeState.handleLoopSubmit}
        workspaceCreate={workspaceCreate}
        workspaceSettings={workspaceSettings}
        provisioning={provisioning}
        toast={toast}
      />
    </div>
  );
}

export default AppShell;
