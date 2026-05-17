import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useChats,
  useDashboardData,
  useLoopGrouping,
  useLoops,
  useProvisioningJob,
  useQuickChatSettings,
  useSshServers,
  useSshSessions,
  useToast,
  useWorkspaces,
} from "../../hooks";
import type { ModelInfo, PublicWorkspace } from "../../types";
import type { QuickChatSettings } from "../../types/preferences";
import { appFetch } from "../../lib/public-path";
import { modelVariantExists } from "../ModelSelector";
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

export type { ShellRoute } from "./shell-types";

interface BranchesResponse {
  currentBranch?: string;
}

interface DefaultBranchResponse {
  defaultBranch?: string;
}

async function parseQuickChatFetchError(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json() as { message?: string; error?: string };
    return data.message ?? data.error ?? fallback;
  } catch {
    return fallback;
  }
}

async function fetchQuickChatModels(workspace: PublicWorkspace): Promise<ModelInfo[]> {
  const response = await appFetch(
    `/api/models?directory=${encodeURIComponent(workspace.directory)}&workspaceId=${encodeURIComponent(workspace.id)}`,
  );
  if (!response.ok) {
    throw new Error(await parseQuickChatFetchError(response, "Failed to load quick chat models"));
  }
  return await response.json() as ModelInfo[];
}

async function fetchQuickChatBaseBranch(workspace: PublicWorkspace): Promise<string> {
  const query = `directory=${encodeURIComponent(workspace.directory)}&workspaceId=${encodeURIComponent(workspace.id)}`;
  const [defaultBranchResponse, branchesResponse] = await Promise.all([
    appFetch(`/api/git/default-branch?${query}`),
    appFetch(`/api/git/branches?${query}`),
  ]);

  const defaultBranch = defaultBranchResponse.ok
    ? ((await defaultBranchResponse.json()) as DefaultBranchResponse).defaultBranch?.trim() ?? ""
    : "";
  const currentBranch = branchesResponse.ok
    ? ((await branchesResponse.json()) as BranchesResponse).currentBranch?.trim() ?? ""
    : "";
  const baseBranch = defaultBranch || currentBranch;

  if (!baseBranch) {
    throw new Error("Could not determine a base branch for quick chat");
  }

  return baseBranch;
}

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
    pullLatestChanges,
    exportConfig,
    importConfig,
  } = useWorkspaces();
  const quickChatSettings = useQuickChatSettings();
  const dashboardData = useDashboardData();
  const provisioning = useProvisioningJob();
  const { workspaceGroups } = useLoopGrouping(loops, workspaces, !workspacesLoading);

  const sidebar = useSidebar(route, onNavigate);
  const { navigateWithinShell, showSidebar } = sidebar;
  const [sidebarSearchFocusRequest, setSidebarSearchFocusRequest] = useState(0);

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
  const sidebarWorkspaceGroups = useMemo(
    () => buildWorkspaceSidebarGroups({
      workspaces,
      loops,
      chats,
      sessions,
    }),
    [chats, loops, sessions, workspaces],
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

  const shellLoading = chatsLoading || loopsLoading || sshSessionsLoading || sshServersLoading || workspacesLoading;
  const shellErrors = [chatsError, loopsError, sshSessionsError, sshServersError, workspaceError].filter(
    Boolean,
  ) as string[];
  const codeExplorerTarget = route.view === "code-explorer" ? route.target : undefined;
  const codeExplorerLoopId = codeExplorerTarget?.contentType === "loop" ? codeExplorerTarget.loopId : null;
  const codeExplorerChatId = codeExplorerTarget?.contentType === "chat" ? codeExplorerTarget.chatId : null;
  const codeExplorerWorkspaceId = codeExplorerTarget?.contentType === "workspace"
    ? codeExplorerTarget.workspaceId
    : null;
  const codeExplorerServerId = codeExplorerTarget?.contentType === "server" ? codeExplorerTarget.serverId : null;

  const selectedLoop =
    route.view === "loop" || route.view === "loop-files"
      ? (loops.find((loop) => loop.config.id === route.loopId) ?? null)
      : codeExplorerLoopId
        ? (loops.find((loop) => loop.config.id === codeExplorerLoopId) ?? null)
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
        : codeExplorerLoopId
          ? (workspaces.find((w) => w.id === selectedLoop?.config.workspaceId) ?? null)
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
      try {
        const models = await fetchQuickChatModels(quickChatWorkspace);
        if (!modelVariantExists(models, settings.model.providerID, settings.model.modelID, settings.model.variant)) {
          toast.error("The selected quick chat model is not available for this workspace");
          return;
        }
      } catch (modelError) {
        toast.error(String(modelError));
        return;
      }

      const baseBranch = await fetchQuickChatBaseBranch(quickChatWorkspace);
      const chat = await createChat({
        workspaceId: quickChatWorkspace.id,
        model: settings.model,
        useWorktree: true,
        autoApprovePermissions: true,
        baseBranch,
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
        onQuickChat={() => void handleQuickChat()}
        version={dashboardData.version ?? undefined}
        sidebarSearchFocusRequest={sidebarSearchFocusRequest}
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
        pullLatestChanges={pullLatestChanges}
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
