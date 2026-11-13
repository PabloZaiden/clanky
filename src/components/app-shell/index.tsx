import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import logoPath from "../../web-app-manifest-192x192.png" with { type: "file" };
import { useToast, routeToHash, type WebAppRoute } from "@pablozaiden/webapp/web";
import { ClankyRoot as WebAppRoot } from "@/platform/web/root";
import { type WebAppConfigState } from "@/platform/web/webapp-config";
import type { Automation } from "@/shared";
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
import { useNotificationSettings } from "../../hooks/useNotificationSettings";
import { useChatTrashActions } from "./use-chat-trash-actions";
import { getClankyClientCapabilities } from "../../client-sdk/capabilities";
import { useBrowserDownloadSettings } from "../app-settings/browser-download-settings";
import { WorkspaceReadOnlyContext } from "../../context/workspace-access-context";
import { isReadOnlyWorkspaceAction, isReadOnlyWorkspaceRoute } from "../../lib/workspace-access";

export function AppShell() {
  const capabilities = getClankyClientCapabilities();
  const toast = useToast();
  const notificationSettings = useNotificationSettings(capabilities.controllerAdministration);
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
    automations,
    terminalSessions,
    executionHosts,
    executionHostsLoading,
    refreshExecutionHosts,
    createTerminalSession,
    updateTerminalSession,
    deleteTerminalSession,
    workspaces,
    workspacesLoading,
    workspacesSaving,
    workspaceError,
    refreshWorkspaces,
    createWorkspace,
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
    chatId,
    composeKind,
    selectedChat,
    selectedWorkspace,
    composeWorkspace,
    composeExecutionHost,
    selectedAutomation,
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

  const automationImportInputRef = useRef<HTMLInputElement>(null);
  const [automationImportWorkspaceId, setAutomationImportWorkspaceId] = useState<string | null>(null);
  const startAutomationImport = useCallback((workspaceId: string): void => {
    const input = automationImportInputRef.current;
    if (!input) {
      toast.error("Automation import is not available yet");
      return;
    }
    setAutomationImportWorkspaceId(workspaceId);
    input.value = "";
    input.click();
  }, [toast]);
  const exportAutomation = useCallback(async (automation: Automation): Promise<void> => {
    try {
      await automations.exportAutomation(automation.config.id);
      toast.success(`Exported automation "${automation.config.name}".`);
    } catch (error) {
      toast.error(String(error));
    }
  }, [automations.exportAutomation, toast]);
  const handleAutomationImportFile = useCallback(async (
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const file = event.currentTarget.files?.[0];
    const workspaceId = automationImportWorkspaceId;
    event.currentTarget.value = "";
    setAutomationImportWorkspaceId(null);
    if (!file || !workspaceId) {
      return;
    }

    try {
      const payload: unknown = JSON.parse(await file.text());
      const imported = await automations.importAutomation(workspaceId, payload);
      if (!imported) {
        toast.error("Failed to import automation");
        return;
      }
      toast.success(`Imported automation "${imported.config.name}".`);
      navigateWithinShell({ view: "automation", automationId: imported.config.id });
    } catch (error) {
      toast.error(String(error));
    }
  }, [
    automationImportWorkspaceId,
    automations.importAutomation,
    navigateWithinShell,
    toast,
  ]);

  const {
    workspaceCreate,
    workspaceSettings,
    selectedChatActions,
    dialogs,
    pullingLatestWorkspaceIds,
    pullLatestWorkspaceChanges,
    getChatLifecycleActions,
    toggleChatPrivate,
    toggleAutomationPrivate,
    toggleTerminalSessionPrivate,
  } = useShellActions({
    route,
    navigateWithinShell,
    provisioning,
    mesh,
    createWorkspace,
    refreshWorkspaces,
    pullLatestChanges,
    dashboardData,
    toast,
    markChatDone,
    deleteChat,
    selectedChat,
    refreshChats,
    updateChat,
    automations,
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
    navigateWithinShell,
    chats,
    workspaces,
    pendingControlFileOpen,
    onControlFileOpenResult,
    terminalSessions,
    executionHosts,
    executionHostsLoading,
    executionHostNodes,
    workspaceGroups,
    sidebarWorkspaceGroups,
    workspacesLoading,
    workspacesSaving,
    workspaceError,
    refreshChats,
    refreshExecutionHosts,
    refreshWorkspaces,
    createTerminalSession,
    deleteWorkspace,
    dashboardData,
    automations,
    editingAutomationId: dialogs.editingAutomationId,
    onSavedAutomationEdit: dialogs.handleAutomationSaved,
    createChat,
    startAutomationImport,
    pullLatestWorkspaceChanges,
    pullingLatestWorkspaceIds,
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
    automations,
    chats,
    createChat,
    startAutomationImport,
    pullLatestWorkspaceChanges,
    pullingLatestWorkspaceIds,
    createTerminalSession,
    dashboardData,
    deleteWorkspace,
    dialogs.editingAutomationId,
    dialogs.handleAutomationSaved,
    navigateWithinShell,
    privateItemsPreference.showPrivateItems,
    pendingControlFileOpen,
    onControlFileOpenResult,
    provisioning,
    workerUpdates,
    refreshChats,
    refreshExecutionHosts,
    refreshWorkspaces,
    executionHostNodes,
    shellErrors,
    shellLoading,
    missingRouteTarget,
    sidebarWorkspaceGroups,
    terminalSessions,
    executionHosts,
    executionHostsLoading,
    toast,
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
    onNavigate: navigateWithinShell,
    quickChatSettings,
    schedulerTimezone,
    githubUsername,
    markdownPreference,
    fullTreePreference,
    privateItemsPreference,
    workspaces,
    workspacesLoading,
    mesh,
    workerUpdates,
    voiceSettings,
    notificationSettings,
  }), ...(browserDownloadSettings ? [browserDownloadSettings] : [])], [
    browserDownloadSettings,
    navigateWithinShell,
    fullTreePreference,
    githubUsername,
    markdownPreference,
    mesh,
    privateItemsPreference,
    quickChatSettings,
    schedulerTimezone,
    workerUpdates,
    workspaces,
    workspacesLoading,
    voiceSettings,
    notificationSettings,
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
    automations: automations.automations,
    handlers: {
      route,
      selectedChat,
      selectedChatActions,
      navigateWithinShell,
      openHarnessActivity,
      onError: (message) => toast.error(message),
      toggleChatPrivate,
      getChatLifecycleActions,
      toggleAutomationPrivate,
      toggleTerminalSessionPrivate,
      openRenameTerminalSession: dialogs.openRenameTerminalSession,
      openDeleteTerminalSession: dialogs.openDeleteTerminalSession,
      setEditingAutomationId: dialogs.setEditingAutomationId,
      setDeleteAutomationTarget: dialogs.setDeleteAutomationTarget,
      setPurgeAutomationTarget: dialogs.setPurgeAutomationTarget,
      exportAutomation,
      automations,
      showPrivateItems: privateItemsPreference.showPrivateItems,
    } satisfies ShellSidebarActionHandlers,
    sidebarSnapshotReady,
    quickChatUnavailableReason,
    quickChatCreating: dialogs.quickChatCreating,
    onQuickChat: () => void dialogs.handleQuickChat(),
    notificationSettings: capabilities.controllerAdministration ? notificationSettings : null,
    voiceActions,
    voiceControls: liveVoice.busy && !liveVoiceExpanded
      ? <LiveVoiceControls voice={liveVoice} expanded={false} onToggleExpanded={expandLiveVoice} /> : null,
  }), [
    trash,
    trashActions,
    automations,
    dialogs.handleQuickChat,
    navigateWithinShell,
    openHarnessActivity,
    dialogs.openDeleteTerminalSession,
    dialogs.openRenameTerminalSession,
    privateItemsPreference.showPrivateItems,
    dialogs.quickChatCreating,
    quickChatUnavailableReason,
    route,
    selectedChat,
    selectedChatActions,
    executionHostNodes,
    dashboardData.remoteOnly,
    sidebarSnapshotReady,
    dialogs.setDeleteAutomationTarget,
    dialogs.setEditingAutomationId,
    dialogs.setPurgeAutomationTarget,
    exportAutomation,
    executionHosts,
    sidebarWorkspaceGroups,
    toast,
    toggleAutomationPrivate,
    toggleChatPrivate,
    getChatLifecycleActions,
    toggleTerminalSessionPrivate,
    workspaces,
    voiceActions,
    capabilities.controllerAdministration,
    notificationSettings,
    liveVoice,
    liveVoiceExpanded,
    expandLiveVoice,
  ]);
  const header = useShellHeader({
    route,
    headerNodes: sidebarComposition.headerNodes,
    chatId,
    composeKind,
    selectedChat,
    selectedWorkspace,
    composeWorkspace,
    composeExecutionHost,
    selectedAutomation,
    chatsLoading,
    automations,
    terminalSessions,
    workspaces,
    editingAutomationId: dialogs.editingAutomationId,
  });
  const readOnly = isReadOnlyWorkspaceRoute(route, { workspaces, chats, automations: automations.automations, terminalSessions });

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
        ref={automationImportInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(event) => void handleAutomationImportFile(event)}
      />
    </WorkspaceReadOnlyContext.Provider>
  );
}

export default AppShell;
