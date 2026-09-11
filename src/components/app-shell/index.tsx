import { useCallback, useMemo, useRef, useState, type ChangeEvent } from "react";
import logoSvgPath from "../../favicon.svg" with { type: "file" };
import {
  useToast,
  WebAppRoot,
  type WebAppRoute,
} from "@pablozaiden/webapp/web";
import { getExecutionHostDefaultDirectory, type Agent, type ExecutionHostDescriptor } from "@/shared";
import {
  buildShellRoutes,
  type ShellRouteCompositionContext,
} from "./shell-route-composition";
import {
  buildShellSidebarComposition,
  type ShellSidebarActionHandlers,
} from "./shell-sidebar-composition";
import { buildShellSettingsSections } from "./shell-settings-composition";
import { useShellActions } from "./use-shell-actions";
import { HOME_ROUTE, useShellNavigation } from "./use-shell-navigation";
import {
  RouteHeaderTitle,
  useShellHeader,
} from "./use-shell-header";
import { useShellResources } from "./use-shell-resources";
import { TerminalSessionModeModal } from "./terminal-session-mode-modal";

export function AppShell() {
  const toast = useToast();
  const [route, setRoute] = useState<WebAppRoute>(HOME_ROUTE);
  const {
    chats,
    chatsLoading,
    refreshChats,
    createChat,
    importExistingChat,
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
    dashboardData,
    provisioning,
    workspaceGroups,
    allWorkspaceGroups,
    sidebarWorkspaceGroups,
    executionHostNodes,
    quickChatWorkspace,
    quickChatUnavailableReason,
    shellLoading,
    shellErrors,
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
  } = useShellResources(route);

  const {
    webAppRootRef,
    handleWebRouteChange,
    navigateWithinShell,
  } = useShellNavigation({
    setRoute,
  });
  const [terminalModePromptHost, setTerminalModePromptHost] = useState<ExecutionHostDescriptor | null>(null);
  const [terminalModePromptSubmitting, setTerminalModePromptSubmitting] = useState(false);
  const openExecutionHostTerminalPrompt = useCallback((host: ExecutionHostDescriptor) => {
    setTerminalModePromptHost(host);
  }, []);
  const handleTerminalModeSelection = useCallback(async (useTmux: boolean): Promise<void> => {
    const host = terminalModePromptHost;
    if (!host || terminalModePromptSubmitting) {
      return;
    }

    setTerminalModePromptSubmitting(true);
    try {
      const session = await createTerminalSession({
        executionHost: host.ref,
        name: `${host.name} terminal`,
        directory: getExecutionHostDefaultDirectory(host),
        connectionMode: "dtach",
        useTmux,
      });
      setTerminalModePromptHost(null);
      navigateWithinShell({ view: "terminal", terminalSessionId: session.config.id });
    } catch (error) {
      toast.error(String(error));
    } finally {
      setTerminalModePromptSubmitting(false);
    }
  }, [
    createTerminalSession,
    navigateWithinShell,
    terminalModePromptHost,
    terminalModePromptSubmitting,
    toast,
  ]);

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
    quickChatSettings,
    githubUsername,
    quickChatWorkspace,
  });

  const routes = useMemo(() => buildShellRoutes({
    shellLoading,
    shellErrors,
    navigateWithinShell,
    tasks,
    chats,
    workspaces,
    terminalSessions,
    executionHosts,
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
    schedulerTimezone: schedulerTimezone.timezone,
    agents,
    editingAgentId: dialogs.editingAgentId,
    onSavedAgentEdit: dialogs.handleAgentSaved,
    composeActionState: composeState.composeActionState,
    setComposeActionState: composeState.setComposeActionState,
    handleTaskSubmit: composeState.handleTaskSubmit,
    createChat,
    importExistingChat,
    workspaceCreate,
    workspaceSettings,
    provisioning,
    toast,
    showPrivateItems: privateItemsPreference.showPrivateItems,
  } satisfies ShellRouteCompositionContext), [
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
    importExistingChat,
    navigateWithinShell,
    privateItemsPreference.showPrivateItems,
    provisioning,
    purgeTask,
    refreshChats,
    refreshExecutionHosts,
    refreshTasks,
    markTaskStarting,
    clearOptimisticTaskStart,
    refreshWorkspaces,
    schedulerTimezone.timezone,
    executionHostNodes,
    servers,
    shellErrors,
    shellLoading,
    sidebarWorkspaceGroups,
    tasks,
    terminalSessions,
    executionHosts,
    toast,
    updateServer,
    workspaceCreate,
    workspaceError,
    workspaceGroups,
    workspaceSettings,
    workspaces,
    workspacesLoading,
    workspacesSaving,
  ]);

  const settingsSections = useMemo(() => buildShellSettingsSections({
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
  }), [
    dashboardData,
    fullTreePreference,
    githubUsername,
    markdownPreference,
    mesh,
    privateItemsPreference,
    quickChatSettings,
    refreshTasks,
    schedulerTimezone,
    workspaces,
    workspacesLoading,
  ]);

  const sidebarSnapshotReady = !shellLoading && shellErrors.length === 0;
  const sidebarComposition = useMemo(() => buildShellSidebarComposition({
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
      onError: (message) => toast.error(message),
      toggleTaskPrivate,
      toggleChatPrivate,
      markChatDone: handleSidebarMarkChatDone,
      toggleAgentPrivate,
      toggleWorkspacePrivate,
      toggleTerminalSessionPrivate,
      toggleSshServerPrivate,
      openExecutionHostTerminalPrompt,
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
  }), [
    agents,
    archivingWorkspaceIds,
    dialogs.handleQuickChat,
    navigateWithinShell,
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
    openExecutionHostTerminalPrompt,
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

  return (
    <>
      <WebAppRoot
        ref={webAppRootRef}
        appName="Clanky"
        appIcon={logoSvgPath}
        homeRoute={HOME_ROUTE}
        sidebar={sidebarComposition.sidebar}
        routes={routes}
        onRouteChange={handleWebRouteChange}
        header={{
          renderTitle: ({ defaultTitle }) => <RouteHeaderTitle model={header.headerModel} defaultTitle={defaultTitle} />,
          getHeaderActions: () => ({
            primary: header.directHeaderActions,
            overflow: header.headerActions,
          }),
        }}
        settings={{ sections: settingsSections }}
        version={dashboardData.version ?? undefined}
      />
      <TerminalSessionModeModal
        isOpen={terminalModePromptHost !== null}
        submitting={terminalModePromptSubmitting}
        onClose={() => setTerminalModePromptHost(null)}
        onSelect={handleTerminalModeSelection}
      />
      {dialogs.modals}
      <input
        ref={agentImportInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(event) => void handleAgentImportFile(event)}
      />
    </>
  );
}

export default AppShell;
