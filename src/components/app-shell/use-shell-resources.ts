import { useCallback, useMemo } from "react";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import { useRealtimeRefreshWithRecovery } from "../../hooks/useRealtimeStream";
import {
  useAgents,
  useChats,
  useDashboardData,
  useFileExplorerFullTreePreference,
  useMarkdownPreference,
  useMesh,
  usePrivateItemsPreference,
  useProvisioningJob,
  useQuickChatSettings,
  useSchedulerTimezone,
  useSshServers,
  useSshSessions,
  useTaskGrouping,
  useTasks,
  useWorkspaces,
} from "../../hooks";
import { buildServerSidebarNodes, buildWorkspaceSidebarGroups } from "./shell-types";
import { getShellRouteSelection } from "./shell-route-composition";

export function useShellResources(route: WebAppRoute) {
  const {
    chats,
    loading: chatsLoading,
    error: chatsError,
    refresh: refreshChats,
    createChat,
    importExistingChat,
    createSshServerChat,
    updateChat,
    markChatDone,
    deleteChat,
  } = useChats();
  const agents = useAgents();
  const {
    tasks,
    loading: tasksLoading,
    error: tasksError,
    refresh: refreshTasks,
    markTaskStarting,
    clearOptimisticTaskStart,
    createTask,
    updateTask,
    purgeTask,
    purgeArchivedWorkspaceTasks,
  } = useTasks();
  const {
    sessions,
    loading: sshSessionsLoading,
    error: sshSessionsError,
    refresh: refreshSshSessions,
    createSession,
    updateSession: updateWorkspaceSshSession,
    deleteSession: deleteWorkspaceSshSession,
  } = useSshSessions({ realtime: false });
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
    updateSession: updateStandaloneSession,
    deleteSession: deleteStandaloneSession,
  } = useSshServers({ realtime: false });

  const refreshSshSessionsAndServers = useCallback(async (): Promise<void> => {
    await Promise.all([
      refreshSshSessions({ showLoading: false }),
      refreshSshServers({ showLoading: false }),
    ]);
  }, [refreshSshServers, refreshSshSessions]);

  useRealtimeRefreshWithRecovery({
    resources: ["ssh-sessions"],
    filters: { resource: "ssh-sessions" },
    refresh: refreshSshSessionsAndServers,
    onReconnect: refreshSshSessionsAndServers,
  });
  const {
    workspaces,
    loading: workspacesLoading,
    saving: workspacesSaving,
    error: workspaceError,
    refresh: refreshWorkspaces,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    pullLatestChanges,
  } = useWorkspaces();
  const quickChatSettings = useQuickChatSettings();
  const schedulerTimezone = useSchedulerTimezone();
  const markdownPreference = useMarkdownPreference();
  const mesh = useMesh();
  const fullTreePreference = useFileExplorerFullTreePreference();
  const privateItemsPreference = usePrivateItemsPreference();
  const dashboardData = useDashboardData();
  const provisioning = useProvisioningJob();
  const { workspaceGroups: allWorkspaceGroups } = useTaskGrouping(
    tasks,
    workspaces,
    !workspacesLoading,
    { includeArchivedWorkspaces: true },
  );
  const workspaceGroups = useMemo(
    () => allWorkspaceGroups.filter(({ workspace }) => workspace.archived !== true),
    [allWorkspaceGroups],
  );

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
      chats,
    }),
    [chats, servers, sessionsByServerId],
  );
  const quickChatWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === quickChatSettings.settings.workspaceId) ?? null,
    [quickChatSettings.settings.workspaceId, workspaces],
  );
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

  const shellLoading = chatsLoading
    || tasksLoading
    || sshSessionsLoading
    || sshServersLoading
    || workspacesLoading
    || agents.loading;
  const shellErrors = [
    chatsError,
    tasksError,
    sshSessionsError,
    sshServersError,
    workspaceError,
    agents.error,
  ].filter((error): error is string => Boolean(error));
  const routeSelection = getShellRouteSelection(route, {
    tasks,
    chats,
    workspaces,
    servers,
    sessionsByServerId,
    agents: agents.agents,
  });

  return {
    chats,
    chatsLoading,
    chatsError,
    refreshChats,
    createChat,
    importExistingChat,
    createSshServerChat,
    updateChat,
    markChatDone,
    deleteChat,
    agents,
    tasks,
    tasksLoading,
    tasksError,
    refreshTasks,
    markTaskStarting,
    clearOptimisticTaskStart,
    createTask,
    updateTask,
    purgeTask,
    purgeArchivedWorkspaceTasks,
    sessions,
    sshSessionsLoading,
    sshSessionsError,
    refreshSshSessions,
    createSession,
    updateWorkspaceSshSession,
    deleteWorkspaceSshSession,
    servers,
    sessionsByServerId,
    sshServersLoading,
    sshServersError,
    refreshSshServers,
    createServer,
    updateServer,
    deleteServer,
    createStandaloneSession,
    updateStandaloneSession,
    deleteStandaloneSession,
    workspaces,
    workspacesLoading,
    workspacesSaving,
    workspaceError,
    refreshWorkspaces,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    pullLatestChanges,
    quickChatSettings,
    schedulerTimezone,
    markdownPreference,
    mesh,
    fullTreePreference,
    privateItemsPreference,
    dashboardData,
    provisioning,
    workspaceGroups,
    allWorkspaceGroups,
    sidebarWorkspaceGroups,
    serverNodes,
    quickChatWorkspace,
    quickChatUnavailableReason,
    shellLoading,
    shellErrors,
    ...routeSelection,
  };
}
