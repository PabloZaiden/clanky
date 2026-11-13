import { useMemo } from "react";
import type { WebAppConfigState } from "@/platform/web/webapp-config";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import {
  useAutomations,
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
  useTerminalSessions,
  useWorkerUpdateJobs,
  useWorkspaces,
  useVoiceSettings,
} from "../../hooks";
import { buildExecutionHostSidebarNodes, buildWorkspaceSidebarGroups } from "./shell-types";
import {
  getShellRouteSelection,
  isMissingShellRouteTarget,
} from "./shell-route-composition";
import { getClankyClientCapabilities } from "../../client-sdk/capabilities";

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
  const automations = useAutomations();
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
  const workspaceGroups = useMemo(
    () => workspaces.filter((workspace) => workspace.archived !== true).map((workspace) => ({ workspace })),
    [workspaces],
  );

  const sidebarWorkspaceGroups = useMemo(
    () => buildWorkspaceSidebarGroups({
      workspaces,
      chats,
      terminalSessions,
    }),
    [chats, terminalSessions, workspaces],
  );
  const executionHostNodes = useMemo(
    () => buildExecutionHostSidebarNodes({
      executionHosts: executionHosts.hosts,
      terminalSessions,
      chats,
    }),
    [chats, executionHosts.hosts, terminalSessions],
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

  const shellLoading = chatsLoading
    || terminalSessionsLoading
    || executionHosts.loading
    || workspacesLoading
    || automations.loading;
  const shellErrors = [
    chatsError,
    terminalSessionsError,
    workspaceError,
    automations.error,
    provisioning.jobsError,
    workerUpdates.jobsError,
    executionHosts.error,
  ].filter((error): error is string => Boolean(error));
  const routeSelection = getShellRouteSelection(route, {
    chats,
    workspaces,
    executionHosts: executionHosts.hosts,
    automations: automations.automations,
  });
  const missingRouteTarget = isMissingShellRouteTarget(route, {
    chats: { items: chats, loading: chatsLoading, error: chatsError },
    workspaces: { items: workspaces, loading: workspacesLoading, error: workspaceError },
    executionHosts: {
      items: executionHosts.hosts,
      loading: executionHosts.loading,
      error: executionHosts.error,
    },
    automations: { items: automations.automations, loading: automations.loading, error: automations.error },
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
    automations,
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
    sidebarWorkspaceGroups,
    executionHostNodes,
    quickChatWorkspace,
    quickChatUnavailableReason,
    shellLoading,
    shellErrors,
    missingRouteTarget,
    ...routeSelection,
  };
}
