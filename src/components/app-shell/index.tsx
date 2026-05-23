import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useChats,
  useDashboardData,
  useTaskGrouping,
  useTasks,
  useProvisioningJob,
  useQuickChatSettings,
  useSshServers,
  useSshSessions,
  useToast,
  useWorkspaces,
} from "../../hooks";
import type { QuickChatSettings } from "../../types/preferences";
import type { UsePasskeyAuthResult } from "../../hooks";
import { buildServerSidebarNodes, buildWorkspaceSidebarGroups } from "./shell-types";
import { ShellSidebarNav } from "./shell-sidebar-nav";
import { ShellMainContent } from "./shell-main-content";
import { useSidebar } from "./use-sidebar";
import { getShellShortcutForKeyboardEvent } from "./shell-navigation";
import { isEditableShortcutTarget } from "./use-sidebar";
import { useWorkspaceCreate } from "./use-workspace-create";
import { useWorkspaceSettingsShell } from "./use-workspace-settings-shell";
import { useComposeState } from "./use-compose-state";
import { Modal } from "../common";

export type { ShellRoute } from "./shell-types";

interface AppShellProps {
  route: import("./shell-types").ShellRoute;
  onNavigate: (route: import("./shell-types").ShellRoute) => void;
  passkeyAuth: UsePasskeyAuthResult;
}

export function AppShell({ route, onNavigate, passkeyAuth }: AppShellProps) {
  const toast = useToast();
  const {
    chats,
    loading: chatsLoading,
    error: chatsError,
    refresh: refreshChats,
    createChat,
  } = useChats();
  const {
    tasks,
    loading: tasksLoading,
    error: tasksError,
    refresh: refreshTasks,
    createTask,
    purgeTask,
    purgeArchivedWorkspaceTasks,
  } = useTasks();
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
    pullLatestChanges,
    exportConfig,
    importConfig,
  } = useWorkspaces();
  const quickChatSettings = useQuickChatSettings();
  const dashboardData = useDashboardData();
  const provisioning = useProvisioningJob();
  const { workspaceGroups } = useTaskGrouping(tasks, workspaces, !workspacesLoading);

  const sidebar = useSidebar(route, onNavigate);
  const { navigateWithinShell, showSidebar } = sidebar;
  const [sidebarSearchFocusRequest, setSidebarSearchFocusRequest] = useState(0);
  const pullingLatestWorkspaceIdsRef = useRef<Set<string>>(new Set());
  const [pullingLatestWorkspaceIds, setPullingLatestWorkspaceIds] = useState<ReadonlySet<string>>(() => new Set());

  const focusSidebarSearch = useCallback(() => {
    showSidebar();
    setSidebarSearchFocusRequest((current) => current + 1);
  }, [showSidebar]);

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
    purgeArchivedWorkspaceTasks,
  });

  const pullLatestWorkspaceChanges = useCallback(async (workspaceId: string) => {
    if (pullingLatestWorkspaceIdsRef.current.has(workspaceId)) {
      return;
    }

    pullingLatestWorkspaceIdsRef.current.add(workspaceId);
    setPullingLatestWorkspaceIds(new Set(pullingLatestWorkspaceIdsRef.current));

    try {
      const result = await pullLatestChanges(workspaceId);
      if (!result.success) {
        toast.error(result.error ?? "Failed to pull latest changes");
        return;
      }

      const branchLabel = result.defaultBranch ?? result.currentBranch ?? "the default branch";
      toast.success(`Pulled latest changes for "${branchLabel}".`);
    } catch (error) {
      toast.error(String(error));
    } finally {
      pullingLatestWorkspaceIdsRef.current.delete(workspaceId);
      setPullingLatestWorkspaceIds(new Set(pullingLatestWorkspaceIdsRef.current));
    }
  }, [pullLatestChanges, toast]);

  const composeState = useComposeState({
    route,
    createTask,
    refreshTasks,
    navigateWithinShell,
    dashboardData,
    toast,
  });

  // Derived memos
  const sidebarWorkspaceGroups = useMemo(
    () => buildWorkspaceSidebarGroups({
      workspaces,
      tasks,
      chats,
      sessions,
    }),
    [chats, tasks, sessions, workspaces],
  );
  const serverNodes = useMemo(
    () => buildServerSidebarNodes({
      servers,
      sessionsByServerId,
      workspaces,
      workspaceSessions: sessions,
    }),
    [servers, sessions, sessionsByServerId, workspaces],
  );
  const quickChatWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === quickChatSettings.settings.workspaceId) ?? null,
    [quickChatSettings.settings.workspaceId, workspaces],
  );
  const quickChatWorkspaceNode = useMemo(() => {
    if (!quickChatWorkspace) {
      return null;
    }
    for (const group of sidebarWorkspaceGroups) {
      const workspaceNode = group.workspaces.find((node) => node.workspace.id === quickChatWorkspace.id);
      if (workspaceNode) {
        return workspaceNode;
      }
    }
    return null;
  }, [quickChatWorkspace, sidebarWorkspaceGroups]);
  const [quickChatCreating, setQuickChatCreating] = useState(false);
  const quickChatUnavailableReason = useMemo(() => {
    if (!quickChatSettings.settings.workspaceId) {
      return "Choose a quick chat workspace in Settings first";
    }
    if (!quickChatWorkspace) {
      return "The selected quick chat workspace no longer exists";
    }
    if (!quickChatSettings.settings.model) {
      return "Choose a quick chat model in Settings first";
    }
    return null;
  }, [
    quickChatSettings.settings.model,
    quickChatSettings.settings.workspaceId,
    quickChatWorkspace,
  ]);

  const shellLoading = chatsLoading || tasksLoading || sshSessionsLoading || sshServersLoading || workspacesLoading;
  const shellErrors = [chatsError, tasksError, sshSessionsError, sshServersError, workspaceError].filter(
    Boolean,
  ) as string[];
  const codeExplorerTarget = route.view === "code-explorer" ? route.target : undefined;
  const codeExplorerTaskId = codeExplorerTarget?.contentType === "task" ? codeExplorerTarget.taskId : null;
  const codeExplorerChatId = codeExplorerTarget?.contentType === "chat" ? codeExplorerTarget.chatId : null;
  const codeExplorerWorkspaceId = codeExplorerTarget?.contentType === "workspace"
    ? codeExplorerTarget.workspaceId
    : null;
  const codeExplorerServerId = codeExplorerTarget?.contentType === "server" ? codeExplorerTarget.serverId : null;

  const selectedTask =
    route.view === "task" || route.view === "task-files"
      ? (tasks.find((task) => task.config.id === route.taskId) ?? null)
      : codeExplorerTaskId
        ? (tasks.find((task) => task.config.id === codeExplorerTaskId) ?? null)
      : null;
  const selectedChat =
    route.view === "chat"
      ? (chats.find((chat) => chat.config.id === route.chatId) ?? null)
      : codeExplorerChatId
        ? (chats.find((chat) => chat.config.id === codeExplorerChatId) ?? null)
        : null;
  const selectedWorkspace =
    route.view === "workspace"
      || route.view === "workspace-files"
      || route.view === "workspace-settings"
      || route.view === "rebuild-workspace"
      || route.view === "restart-workspace"
      ? (workspaces.find((w) => w.id === route.workspaceId) ?? null)
      : codeExplorerWorkspaceId
        ? (workspaces.find((w) => w.id === codeExplorerWorkspaceId) ?? null)
        : codeExplorerTaskId
          ? (workspaces.find((w) => w.id === selectedTask?.config.workspaceId) ?? null)
          : codeExplorerChatId
            ? (workspaces.find((w) => w.id === selectedChat?.config.workspaceId) ?? null)
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
    route.view === "ssh-server"
      || route.view === "ssh-server-settings"
      || route.view === "server-files"
      || route.view === "server-arise"
      ? (servers.find((s) => s.config.id === route.serverId) ?? null)
      : codeExplorerServerId
        ? (servers.find((s) => s.config.id === codeExplorerServerId) ?? null)
        : null;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const shortcut = getShellShortcutForKeyboardEvent(event);
      if (!shortcut || isEditableShortcutTarget(event.target)) {
        return;
      }

      event.preventDefault();
      if (shortcut.action === "sidebar-search") {
        focusSidebarSearch();
        return;
      }
      if (shortcut.route) {
        navigateWithinShell(shortcut.route);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [focusSidebarSearch, navigateWithinShell]);

  const handleQuickChat = useCallback(async () => {
    if (quickChatSettings.loading || quickChatCreating) {
      return;
    }

    const settings: QuickChatSettings = quickChatSettings.settings;
    if (!settings.workspaceId) {
      toast.error("Choose a quick chat workspace in Settings first");
      return;
    }
    if (!quickChatWorkspace) {
      toast.error("The selected quick chat workspace no longer exists");
      return;
    }
    if (!settings.model) {
      toast.error("Choose a quick chat model in Settings first");
      return;
    }

    setQuickChatCreating(true);
    try {
      const chat = await createChat({
        workspaceId: quickChatWorkspace.id,
        model: settings.model,
        useWorktree: true,
        autoApprovePermissions: true,
        quick: true,
      });
      if (!chat) {
        toast.error("Failed to create quick chat");
        return;
      }
      navigateWithinShell({ view: "chat", chatId: chat.config.id });
    } catch (error) {
      toast.error(String(error));
    } finally {
      setQuickChatCreating(false);
    }
  }, [
    createChat,
    navigateWithinShell,
    quickChatCreating,
    quickChatSettings.loading,
    quickChatSettings.settings,
    quickChatWorkspace,
    toast,
  ]);

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
        toggleSidebar={sidebar.toggleSidebar}
        isNodeCollapsed={sidebar.isNodeCollapsed}
        toggleNodeCollapsed={sidebar.toggleNodeCollapsed}
        workspaceGroups={sidebarWorkspaceGroups}
        serverNodes={serverNodes}
        quickChatWorkspace={quickChatWorkspaceNode}
        quickChatLoading={quickChatSettings.loading || quickChatCreating}
        quickChatUnavailableReason={quickChatUnavailableReason}
        onQuickChat={() => void handleQuickChat()}
        onConfigureQuickChat={() => navigateWithinShell({ view: "settings" })}
        version={dashboardData.version ?? undefined}
        sidebarSearchFocusRequest={sidebarSearchFocusRequest}
        pullLatestWorkspaceChanges={pullLatestWorkspaceChanges}
        pullingLatestWorkspaceIds={pullingLatestWorkspaceIds}
      />

      <ShellMainContent
        route={route}
        shellLoading={shellLoading}
        shellErrors={shellErrors}
        sidebarCollapsed={sidebar.sidebarCollapsed}
        shellHeaderOffsetClassName={sidebar.shellHeaderOffsetClassName}
        openSidebar={sidebar.openSidebar}
        navigateWithinShell={navigateWithinShell}
        tasks={tasks}
        chats={chats}
        workspaces={workspaces}
        sessions={sessions}
        servers={servers}
        sessionsByServerId={sessionsByServerId}
        serverNodes={serverNodes}
        workspaceGroups={workspaceGroups}
        sidebarWorkspaceGroups={sidebarWorkspaceGroups}
        quickChatWorkspace={quickChatWorkspaceNode}
        workspacesLoading={workspacesLoading}
        workspacesSaving={workspacesSaving}
        workspaceError={workspaceError}
        selectedTask={selectedTask}
        selectedChat={selectedChat}
        selectedWorkspace={selectedWorkspace}
        composeWorkspace={composeWorkspace}
        composeServer={composeServer}
        composeServerSessionCount={composeServerSessionCount}
        selectedServer={selectedServer}
        refreshTasks={refreshTasks}
        refreshChats={refreshChats}
        purgeTask={purgeTask}
        refreshSshSessions={refreshSshSessions}
        refreshSshServers={refreshSshServers}
        refreshWorkspaces={refreshWorkspaces}
        createSession={createSession}
        createStandaloneSession={createStandaloneSession}
        createServer={createServer}
        updateServer={updateServer}
        deleteServer={deleteServer}
        deleteWorkspace={deleteWorkspace}
        pullLatestWorkspaceChanges={pullLatestWorkspaceChanges}
        pullingLatestWorkspaceIds={pullingLatestWorkspaceIds}
        exportConfig={exportConfig}
        importConfig={importConfig}
        dashboardData={dashboardData}
        passkeyAuth={passkeyAuth}
        quickChatSettings={quickChatSettings.settings}
        quickChatSettingsLoading={quickChatSettings.loading}
        quickChatSettingsSaving={quickChatSettings.saving}
        quickChatSettingsError={quickChatSettings.error}
        updateQuickChatSettings={quickChatSettings.updateSettings}
        composeActionState={composeState.composeActionState}
        setComposeActionState={composeState.setComposeActionState}
        handleTaskSubmit={composeState.handleTaskSubmit}
        createChat={createChat}
        workspaceCreate={workspaceCreate}
        workspaceSettings={workspaceSettings}
        provisioning={provisioning}
        toast={toast}
      />

      <Modal
        isOpen={quickChatCreating}
        onClose={() => {}}
        title="Creating quick chat"
        description="Your quick chat is being prepared."
        size="sm"
        showCloseButton={false}
        closeOnOverlayClick={false}
      >
        <div className="flex items-center gap-3 text-sm text-gray-600 dark:text-gray-300">
          <span
            className="inline-block h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-gray-400 border-t-transparent dark:border-gray-500"
            aria-hidden="true"
          />
          <span>Creating a new quick chat...</span>
        </div>
      </Modal>
    </div>
  );
}

export default AppShell;
