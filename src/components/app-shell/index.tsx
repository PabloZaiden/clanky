import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import logoPath from "../../web-app-manifest-192x192.png" with { type: "file" };
import {
  useToast,
  routeToHash,
  WebAppRoot,
  type WebAppRoute,
  type WebAppConfigState,
} from "@pablozaiden/webapp/web";
import type { Agent } from "@/shared";
import {
  buildShellRoutes,
  ShellRuntimeObserver,
  type ShellRouteCompositionContext,
} from "./shell-route-composition";
import { buildShellSidebarComposition } from "./shell-sidebar-composition";
import type { ShellSidebarActionHandlers } from "./shell-sidebar-types";
import { buildShellSettingsSections } from "./shell-settings-composition";
import { useShellActions } from "./use-shell-actions";
import { HOME_ROUTE, useShellNavigation } from "./use-shell-navigation";
import {
  RouteHeaderTitle,
  useShellHeader,
} from "./use-shell-header";
import { useShellResources } from "./use-shell-resources";
import { useControlUiActions } from "./use-control-ui-actions";
import { LiveVoiceContext, useLiveVoice } from "../../hooks/useLiveVoice";
import { buildVoiceLauncherActions, LiveVoiceControls } from "./live-voice-controls";
import { useVoiceClientActions } from "./use-voice-client-actions";
import { useChatTrash } from "../../hooks/useChatTrash";
import { useChatTrashActions } from "./use-chat-trash-actions";
import { getClankyClientCapabilities } from "../../client-sdk/capabilities";
import { useBrowserDownloadSettings } from "../app-settings/browser-download-settings";
import { WorkspaceReadOnlyContext } from "../../context/workspace-access-context";
import { isReadOnlyWorkspaceAction, isReadOnlyWorkspaceRoute } from "../../lib/workspace-access";

export function AppShell() {
  const capabilities = getClankyClientCapabilities();
  const toast = useToast();
  const browserDownloadSettings = useBrowserDownloadSettings();
  const [isOwner, setIsOwner] = useState(false);
  const [frameworkConfig, setFrameworkConfig] = useState<WebAppConfigState["config"]>(undefined);
  const [route, setRoute] = useState<WebAppRoute>(HOME_ROUTE);
  const [activityRoute, setActivityRoute] = useState<WebAppRoute | null>(null);
  const [liveVoiceExpanded, setLiveVoiceExpanded] = useState(true);
  const resources = useShellResources(route, isOwner, frameworkConfig);
  const {
    chats,
    chatsLoading,
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
    refreshTasks,
    markTaskStarting,
    clearOptimisticTaskStart,
    createTask,
    updateTask,
    purgeTask,
    purgeArchivedWorkspaceTasks,
    terminalSessions,
    executionHosts,
    executionHostsLoading,
    refreshExecutionHosts,
    createTerminalSession,
    updateTerminalSession,
    deleteTerminalSession,
    servers,
    createServer,
    updateServer,
    deleteServer,
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
    taskId,
    chatId,
    composeKind,
    selectedTask,
    selectedChat,
    selectedWorkspace,
    composeWorkspace,
    composeServer,
    composeExecutionHost,
    selectedAgent,
  } = resources;

  const {
    webAppRootRef,
    handleWebRouteChange,
    navigateWithinShell,
  } = useShellNavigation({
    setRoute,
  });
  useEffect(() => {
    if (missingRouteTarget) {
      navigateWithinShell(HOME_ROUTE);
    }
  }, [missingRouteTarget, navigateWithinShell]);

  const liveVoiceCall = useLiveVoice({
    enabled: voiceSettings.settings.live.configured, route,
  });
  const trash = useChatTrash(privateItemsPreference.showPrivateItems);
  const trashActions = useChatTrashActions(navigateWithinShell, refreshChats, workspaces);
  const startLiveVoice = useCallback(async (): Promise<void> => {
    setLiveVoiceExpanded(true);
    webAppRootRef.current?.sidebar.close();
    await liveVoiceCall.start();
  }, [liveVoiceCall.start]);
  const liveVoice = useMemo(() => ({ ...liveVoiceCall, start: startLiveVoice }), [liveVoiceCall, startLiveVoice]);
  const expandLiveVoice = useCallback((): void => {
    setLiveVoiceExpanded(true);
    webAppRootRef.current?.sidebar.close();
  }, []);
  const voiceClient = useVoiceClientActions({ voice: liveVoice, rootRef: webAppRootRef });
  const voiceActions = useMemo(() => capabilities.voice ? buildVoiceLauncherActions(
    liveVoice, () => navigateWithinShell({ view: "settings" }),
  ) : [], [capabilities.voice, liveVoice, navigateWithinShell]);
  const {
    pendingFileOpen: pendingControlFileOpen,
    reportFileOpenResult: onControlFileOpenResult,
  } = useControlUiActions({
    route,
    navigateWithinShell,
    resources,
    handleClientAction: voiceClient.handleAction,
  });
  const openHarnessActivity = useCallback((entityRoute: WebAppRoute): void => {
    setActivityRoute(entityRoute);
    navigateWithinShell(entityRoute);
  }, [navigateWithinShell]);
  const closeHarnessActivity = useCallback(() => setActivityRoute(null), []);
  const handleRouteChange = useCallback((nextRoute: WebAppRoute): void => {
    setActivityRoute((current) => current && Object.entries(current).every(([key, value]) => nextRoute[key] === value) ? current : null);
    handleWebRouteChange(nextRoute);
  }, [handleWebRouteChange]);

  const agentImportInputRef = useRef<HTMLInputElement>(null);
  const [agentImportWorkspaceId, setAgentImportWorkspaceId] = useState<string | null>(null);
  const startAgentImport = useCallback((workspaceId: string): void => {
    const input = agentImportInputRef.current;
    if (!input) {
      toast.error("Agent import is not available yet");
      return;
    }
    setAgentImportWorkspaceId(workspaceId);
    input.value = "";
    input.click();
  }, [toast]);
  const exportAgent = useCallback(async (agent: Agent): Promise<void> => {
    try {
      await agents.exportAgent(agent.config.id);
      toast.success(`Exported agent "${agent.config.name}".`);
    } catch (error) {
      toast.error(String(error));
    }
  }, [agents.exportAgent, toast]);
  const handleAgentImportFile = useCallback(async (
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const file = event.currentTarget.files?.[0];
    const workspaceId = agentImportWorkspaceId;
    event.currentTarget.value = "";
    setAgentImportWorkspaceId(null);
    if (!file || !workspaceId) {
      return;
    }

    try {
      const payload: unknown = JSON.parse(await file.text());
      const imported = await agents.importAgent(workspaceId, payload);
      if (!imported) {
        toast.error("Failed to import agent");
        return;
      }
      toast.success(`Imported agent "${imported.config.name}".`);
      navigateWithinShell({ view: "agent", agentId: imported.config.id });
    } catch (error) {
      toast.error(String(error));
    }
  }, [
    agentImportWorkspaceId,
    agents.importAgent,
    navigateWithinShell,
    toast,
  ]);

  const {
    workspaceCreate,
    workspaceSettings,
    composeState,
    selectedChatActions,
    dialogs,
    pullingLatestWorkspaceIds,
    archivingWorkspaceIds,
    pullLatestWorkspaceChanges,
    toggleWorkspaceArchived,
    handleSidebarMarkChatDone,
    toggleTaskPrivate,
    toggleChatPrivate,
    toggleAgentPrivate,
    toggleWorkspacePrivate,
    toggleTerminalSessionPrivate,
    toggleSshServerPrivate,
    stopSidebarTask,
  } = useShellActions({
    route,
    navigateWithinShell,
    servers,
    provisioning,
    mesh,
    createWorkspace,
    refreshWorkspaces,
    workspaceGroups: allWorkspaceGroups,
    purgeArchivedWorkspaceTasks,
    pullLatestChanges,
    updateWorkspace,
    createTask,
    refreshTasks,
    dashboardData,
    toast,
    markChatDone,
    deleteChat,
    selectedChat,
    refreshChats,
    updateChat,
    agents,
    updateTask,
    updateServer,
    updateTerminalSession,
    deleteTerminalSession,
    createChat,
    createChatHere,
    createExecutionHostChat,
    quickChatSettings,
    githubUsername,
    quickChatWorkspace,
  });

  const routes = useMemo(() => buildShellRoutes({
    trashActions,
    activityRoute,
    closeHarnessActivity,
    openHarnessActivity,
    shellLoading,
    shellErrors,
    missingRouteTarget,
    taskRouteLoading,
    navigateWithinShell,
    tasks,
    chats,
    workspaces,
    pendingControlFileOpen,
    onControlFileOpenResult,
    terminalSessions,
    executionHosts,
    executionHostsLoading,
    servers,
    executionHostNodes,
    workspaceGroups,
    sidebarWorkspaceGroups,
    workspacesLoading,
    workspacesSaving,
    workspaceError,
    refreshTasks,
    markTaskStarting,
    clearOptimisticTaskStart,
    refreshChats,
    purgeTask,
    refreshExecutionHosts,
    refreshWorkspaces,
    createTerminalSession,
    createServer,
    updateServer,
    deleteServer,
    deleteWorkspace,
    dashboardData,
    agents,
    editingAgentId: dialogs.editingAgentId,
    onSavedAgentEdit: dialogs.handleAgentSaved,
    composeActionState: composeState.composeActionState,
    setComposeActionState: composeState.setComposeActionState,
    handleTaskSubmit: composeState.handleTaskSubmit,
    createChat,
    workspaceCreate,
    workspaceSettings,
    provisioning,
    workerUpdates,
    toast,
    showPrivateItems: privateItemsPreference.showPrivateItems,
  } satisfies ShellRouteCompositionContext), [
    trashActions,
    activityRoute,
    closeHarnessActivity,
    openHarnessActivity,
    agents,
    chats,
    composeState.composeActionState,
    composeState.handleTaskSubmit,
    composeState.setComposeActionState,
    createChat,
    createServer,
    createTerminalSession,
    dashboardData,
    deleteServer,
    deleteWorkspace,
    dialogs.editingAgentId,
    dialogs.handleAgentSaved,
    navigateWithinShell,
    privateItemsPreference.showPrivateItems,
    pendingControlFileOpen,
    onControlFileOpenResult,
    provisioning,
    workerUpdates,
    purgeTask,
    refreshChats,
    refreshExecutionHosts,
    refreshTasks,
    markTaskStarting,
    clearOptimisticTaskStart,
    refreshWorkspaces,
    executionHostNodes,
    servers,
    shellErrors,
    shellLoading,
    missingRouteTarget,
    taskRouteLoading,
    sidebarWorkspaceGroups,
    tasks,
    terminalSessions,
    executionHosts,
    executionHostsLoading,
    toast,
    updateServer,
    setIsOwner,
    workspaceCreate,
    workspaceError,
    workspaceGroups,
    workspaceSettings,
    workspaces,
    workspacesLoading,
    workspacesSaving,
  ]);

  const settingsSections = useMemo(() => [...buildShellSettingsSections({
    quickChatSettings,
    schedulerTimezone,
    githubUsername,
    markdownPreference,
    fullTreePreference,
    privateItemsPreference,
    dashboardData,
    workspaces,
    workspacesLoading,
    refreshTasks,
    mesh,
    workerUpdates,
    voiceSettings,
  }), ...(browserDownloadSettings ? [browserDownloadSettings] : [])], [
    browserDownloadSettings,
    dashboardData,
    fullTreePreference,
    githubUsername,
    markdownPreference,
    mesh,
    privateItemsPreference,
    quickChatSettings,
    refreshTasks,
    schedulerTimezone,
    workerUpdates,
    workspaces,
    workspacesLoading,
    voiceSettings,
  ]);

  const sidebarSnapshotReady = !shellLoading && shellErrors.length === 0;
  const sidebarComposition = useMemo(() => buildShellSidebarComposition({
    trash,
    trashActions,
    sidebarWorkspaceGroups,
    executionHostNodes,
    executionHosts,
    remoteOnly: dashboardData.remoteOnly,
    chats,
    terminalSessions,
    workspaces,
    agents: agents.agents,
    handlers: {
      route,
      selectedChat,
      selectedChatActions,
      navigateWithinShell,
      openHarnessActivity,
      onError: (message) => toast.error(message),
      toggleTaskPrivate,
      toggleChatPrivate,
      markChatDone: handleSidebarMarkChatDone,
      toggleAgentPrivate,
      toggleWorkspacePrivate,
      toggleTerminalSessionPrivate,
      toggleSshServerPrivate,
      stopSidebarTask,
      openRenameTerminalSession: dialogs.openRenameTerminalSession,
      openDeleteTerminalSession: dialogs.openDeleteTerminalSession,
      pullLatestWorkspaceChanges,
      pullingLatestWorkspaceIds,
      toggleWorkspaceArchived,
      archivingWorkspaceIds,
      setEditingAgentId: dialogs.setEditingAgentId,
      setDeleteAgentTarget: dialogs.setDeleteAgentTarget,
      setPurgeAgentTarget: dialogs.setPurgeAgentTarget,
      exportAgent,
      startAgentImport,
      agents,
      showPrivateItems: privateItemsPreference.showPrivateItems,
    } satisfies ShellSidebarActionHandlers,
    sidebarSnapshotReady,
    quickChatUnavailableReason,
    quickChatCreating: dialogs.quickChatCreating,
    onQuickChat: () => void dialogs.handleQuickChat(),
    voiceActions,
    voiceControls: liveVoice.busy && !liveVoiceExpanded
      ? <LiveVoiceControls voice={liveVoice} expanded={false} onToggleExpanded={expandLiveVoice} /> : null,
  }), [
    trash,
    trashActions,
    agents,
    archivingWorkspaceIds,
    dialogs.handleQuickChat,
    navigateWithinShell,
    openHarnessActivity,
    dialogs.openDeleteTerminalSession,
    dialogs.openRenameTerminalSession,
    privateItemsPreference.showPrivateItems,
    pullLatestWorkspaceChanges,
    pullingLatestWorkspaceIds,
    dialogs.quickChatCreating,
    quickChatUnavailableReason,
    route,
    selectedChat,
    selectedChatActions,
    executionHostNodes,
    dashboardData.remoteOnly,
    sidebarSnapshotReady,
    dialogs.setDeleteAgentTarget,
    dialogs.setEditingAgentId,
    dialogs.setPurgeAgentTarget,
    exportAgent,
    executionHosts,
    sidebarWorkspaceGroups,
    stopSidebarTask,
    startAgentImport,
    toast,
    toggleAgentPrivate,
    toggleChatPrivate,
    handleSidebarMarkChatDone,
    toggleSshServerPrivate,
    toggleTaskPrivate,
    toggleTerminalSessionPrivate,
    toggleWorkspaceArchived,
    toggleWorkspacePrivate,
    workspaces,
    voiceActions,
    liveVoice,
    liveVoiceExpanded,
    expandLiveVoice,
  ]);
  const header = useShellHeader({
    route,
    headerNodes: sidebarComposition.headerNodes,
    taskId,
    chatId,
    composeKind,
    selectedTask,
    selectedChat,
    selectedWorkspace,
    composeWorkspace,
    composeServer,
    composeExecutionHost,
    selectedAgent,
    tasksLoading,
    chatsLoading,
    agents,
    servers,
    terminalSessions,
    workspaces,
    editingAgentId: dialogs.editingAgentId,
    composeActionState: composeState.composeActionState,
  });
  const readOnly = isReadOnlyWorkspaceRoute(route, { workspaces, tasks, chats, agents: agents.agents, terminalSessions });

  return (
    <WorkspaceReadOnlyContext.Provider value={readOnly}>
      <LiveVoiceContext.Provider value={liveVoice}>
        <WebAppRoot
          ref={webAppRootRef}
          appName="Clanky"
          appIcon={logoPath}
          homeRoute={HOME_ROUTE}
          sidebar={sidebarComposition.sidebar}
          mainOverlay={<>
            <ShellRuntimeObserver onOwnerChange={setIsOwner} onConfigChange={setFrameworkConfig} />
            {liveVoice.busy && liveVoiceExpanded
              ? <LiveVoiceControls voice={liveVoice} expanded onToggleExpanded={() => setLiveVoiceExpanded(false)} />
              : null}
          </>}
          routes={routes}
          onRouteChange={handleRouteChange}
          header={{
            renderTitle: ({ defaultTitle }) => <RouteHeaderTitle key={routeToHash(header.headerOwnerRoute ?? route)} model={header.headerModel} defaultTitle={defaultTitle} />,
            getHeaderActions: () => ({
              primary: readOnly ? [] : header.directHeaderActions,
              overflow: readOnly ? header.headerActions?.filter(isReadOnlyWorkspaceAction) : header.headerActions,
            }),
          }}
          settings={{ sections: settingsSections }}
          version={dashboardData.version ?? undefined}
        />
      </LiveVoiceContext.Provider>
      {dialogs.modals}
      {trashActions.dialogs}
      {voiceClient.dialogs}
      <input
        ref={agentImportInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(event) => void handleAgentImportFile(event)}
      />
    </WorkspaceReadOnlyContext.Provider>
  );
}

export default AppShell;
