import { useEffect, useMemo, useState } from "react";
import type { WebAppConfigState, WebAppRoute } from "@pablozaiden/webapp/web";
import {
  useAgents,
  useChats,
  useDashboardData,
  useFileExplorerFullTreePreference,
  useExecutionHosts,
  useGithubUsername,
  useMarkdownPreference,
  useMesh,
  usePrivateItemsPreference,
  useProvisioningJob,
  useQuickChatSettings,
  useSchedulerTimezone,
  useSshServers,
  useTaskGrouping,
  useTasks,
  useTerminalSessions,
  useWorkerUpdateJobs,
  useWorkspaces,
  useVoiceSettings,
} from "../../hooks";
import { buildExecutionHostSidebarNodes, buildWorkspaceSidebarGroups } from "./shell-types";
import {
  getShellRouteSelection,
  getShellRouteTaskId,
  isMissingShellRouteTarget,
} from "./shell-route-composition";
import { getClankyClientCapabilities } from "../../client-sdk/capabilities";

interface TaskRouteVerification {
  taskId: string;
  status: "checking" | "missing" | "present" | "failed";
}

export function useShellResources(route: WebAppRoute, isOwner: boolean, config: WebAppConfigState["config"]) {
  const capabilities = getClankyClientCapabilities();
  const {
    chats,
    loading: chatsLoading,
    error: chatsError,
    refresh: refreshChats,
    createChat,
    createChatHere,
    createExecutionHostChat,
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
    refreshTaskById,
    markTaskStarting,
    clearOptimisticTaskStart,
    createTask,
    updateTask,
    purgeTask,
    purgeArchivedWorkspaceTasks,
  } = useTasks();
  const {
    servers,
    loading: sshServersLoading,
    error: sshServersError,
    refresh: refreshSshServers,
    createServer,
    updateServer,
    deleteServer,
  } = useSshServers({ enabled: capabilities.executionHosts });
  const {
    sessions: terminalSessions,
    loading: terminalSessionsLoading,
    error: terminalSessionsError,
    refresh: refreshTerminalSessions,
    createSession: createTerminalSession,
    updateSession: updateTerminalSession,
    deleteSession: deleteTerminalSession,
  } = useTerminalSessions();
  const executionHosts = useExecutionHosts({ enabled: capabilities.executionHosts });
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
  const schedulerTimezone = useSchedulerTimezone({ enabled: capabilities.controllerAdministration });
  const githubUsername = useGithubUsername({ enabled: capabilities.controllerAdministration });
  const markdownPreference = useMarkdownPreference();
  const mesh = useMesh({ enabled: capabilities.controllerAdministration });
  const fullTreePreference = useFileExplorerFullTreePreference();
  const privateItemsPreference = usePrivateItemsPreference();
  const voiceSettings = useVoiceSettings({ enabled: capabilities.voice });
  const dashboardData = useDashboardData(config);
  const provisioning = useProvisioningJob({ enabled: capabilities.provisioning });
  const workerUpdates = useWorkerUpdateJobs({ enabled: isOwner && capabilities.controllerAdministration });
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
      terminalSessions,
    }),
    [chats, tasks, terminalSessions, workspaces],
  );
  const executionHostNodes = useMemo(
    () => buildExecutionHostSidebarNodes({
      executionHosts: executionHosts.hosts,
      servers,
      terminalSessions,
      chats,
    }),
    [chats, executionHosts.hosts, servers, terminalSessions],
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
    if (quickChatWorkspace.access === "read") {
      return "The selected quick chat workspace is read-only";
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

  const taskRouteId = getShellRouteTaskId(route);
  const [taskRouteVerification, setTaskRouteVerification] = useState<TaskRouteVerification | null>(null);

  useEffect(() => {
    if (!taskRouteId) {
      setTaskRouteVerification(null);
      return;
    }
    if (tasksLoading || tasksError !== null) {
      return;
    }

    const controller = new AbortController();
    setTaskRouteVerification({ taskId: taskRouteId, status: "checking" });
    void refreshTaskById(taskRouteId, controller.signal).then((exists) => {
      if (controller.signal.aborted) {
        return;
      }
      setTaskRouteVerification({
        taskId: taskRouteId,
        status: exists === false ? "missing" : exists === true ? "present" : "failed",
      });
    });
    return () => controller.abort();
  }, [refreshTaskById, taskRouteId, tasksError, tasksLoading]);

  const routedTaskVerification = taskRouteVerification?.taskId === taskRouteId
    ? taskRouteVerification
    : null;
  const taskRouteLoading = Boolean(taskRouteId)
    && tasksError === null
    && (routedTaskVerification === null || routedTaskVerification.status === "checking");
  const missingTaskRouteTarget = routedTaskVerification?.status === "missing";

  const shellLoading = chatsLoading
    || tasksLoading
    || sshServersLoading
    || terminalSessionsLoading
    || executionHosts.loading
    || workspacesLoading
    || agents.loading;
  const shellErrors = [
    chatsError,
    tasksError,
    sshServersError,
    terminalSessionsError,
    workspaceError,
    agents.error,
    provisioning.jobsError,
    workerUpdates.jobsError,
    executionHosts.error,
  ].filter((error): error is string => Boolean(error));
  const routeSelection = getShellRouteSelection(route, {
    tasks,
    chats,
    workspaces,
    servers,
    executionHosts: executionHosts.hosts,
    agents: agents.agents,
  });
  const missingRouteTarget = missingTaskRouteTarget || isMissingShellRouteTarget(route, {
    chats: { items: chats, loading: chatsLoading, error: chatsError },
    workspaces: { items: workspaces, loading: workspacesLoading, error: workspaceError },
    servers: { items: servers, loading: sshServersLoading, error: sshServersError },
    executionHosts: {
      items: executionHosts.hosts,
      loading: executionHosts.loading,
      error: executionHosts.error,
    },
    agents: { items: agents.agents, loading: agents.loading, error: agents.error },
    terminalSessions: {
      items: terminalSessions,
      loading: terminalSessionsLoading,
      error: terminalSessionsError,
    },
  });

  return {
    chats,
    chatsLoading,
    chatsError,
    refreshChats,
    createChat,
    createChatHere,
    createExecutionHostChat,
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
    servers,
    sshServersLoading,
    sshServersError,
    refreshSshServers,
    createServer,
    updateServer,
    deleteServer,
    terminalSessions,
    executionHosts: executionHosts.hosts,
    executionHostsLoading: executionHosts.loading,
    executionHostsError: executionHosts.error,
    refreshExecutionHosts: executionHosts.refresh,
    terminalSessionsLoading,
    terminalSessionsError,
    refreshTerminalSessions,
    createTerminalSession,
    updateTerminalSession,
    deleteTerminalSession,
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
    githubUsername,
    markdownPreference,
    mesh,
    fullTreePreference,
    privateItemsPreference,
    voiceSettings,
    dashboardData,
    provisioning,
    workerUpdates,
    workspaceGroups,
    allWorkspaceGroups,
    sidebarWorkspaceGroups,
    executionHostNodes,
    quickChatWorkspace,
    quickChatUnavailableReason,
    shellLoading,
    shellErrors,
    missingRouteTarget,
    taskRouteLoading,
    ...routeSelection,
  };
}
