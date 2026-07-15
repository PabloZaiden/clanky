import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  replaceWebAppRoute,
  useLogLevel,
  useToast,
  WebAppRoot,
  type ActionMenuItem,
  type SidebarNode,
  type WebAppRoute,
} from "@pablozaiden/webapp/web";
import { DEFAULT_LOG_LEVEL, setLogLevel } from "../../lib/logger";
import {
  useChats,
  useAgents,
  useDashboardData,
  useTaskGrouping,
  useTasks,
  useProvisioningJob,
  useFileExplorerFullTreePreference,
  useMarkdownPreference,
  usePrivateItemsPreference,
  useQuickChatSettings,
  useSchedulerTimezone,
  useSshServers,
  useSshSessions,
  useWorkspaces,
  stopTaskApi,
} from "../../hooks";
import {
  buildServerSidebarNodes,
  buildWorkspaceSidebarGroups,
} from "./shell-types";
import {
  buildShellRoutes,
  getShellRouteSelection,
  type ShellRouteCompositionContext,
} from "./shell-route-composition";
import {
  buildShellSidebarComposition,
  getHeaderOwnerRoute,
  sidebarNodeMatchesRoute,
  type ShellSidebarActionHandlers,
} from "./shell-sidebar-composition";
import { getRouteString } from "./route-fields";
import { getShellShortcutForKeyboardEvent, isEditableShortcutTarget } from "./shell-shortcuts";
import { useWorkspaceCreate } from "./use-workspace-create";
import { useWorkspaceSettingsShell } from "./use-workspace-settings-shell";
import { useComposeState } from "./use-compose-state";
import { useChatActions } from "./chat-actions";
import { buildShellSettingsSections } from "./shell-settings-composition";
import { useShellDialogComposition } from "./shell-dialog-composition";
import type { Agent, Chat, SshServer, SshServerSession, SshSession, Task, Workspace } from "@/shared";
import { StatusBadge } from "../common";

const HOME_ROUTE: WebAppRoute = { view: "home" };

interface HeaderModel {
  title: string;
  subtitle?: string;
  badge?: string;
  badgeVariant?: SidebarNode["badgeVariant"];
}

function RouteHeaderTitle({ model }: { model: HeaderModel }) {
  const { level } = useLogLevel();

  useEffect(() => {
    try {
      setLogLevel(level ?? DEFAULT_LOG_LEVEL);
    } catch {
      setLogLevel(DEFAULT_LOG_LEVEL);
    }
  }, [level]);

  return (
    <span className="flex min-w-0 max-w-full flex-1 items-center gap-1.5 overflow-hidden">
      <span className="min-w-0 flex-shrink truncate text-lg font-bold text-gray-900 dark:text-gray-100">
        {model.title}
      </span>
      {model.badge ? (
        <StatusBadge variant={model.badgeVariant} size="sm" className="shrink-0">
          {model.badge}
        </StatusBadge>
      ) : null}
      {model.subtitle ? (
        <span className="min-w-0 flex-shrink truncate text-xs font-normal text-gray-500 dark:text-gray-400">
          {model.subtitle}
        </span>
      ) : null}
    </span>
  );
}

export function AppShell() {
  const toast = useToast();
  const [route, setRoute] = useState<WebAppRoute>(HOME_ROUTE);
  const handleWebRouteChange = useCallback((nextRoute: WebAppRoute) => setRoute(nextRoute), []);
  const {
    chats,
    loading: chatsLoading,
    error: chatsError,
    refresh: refreshChats,
    createChat,
    importExistingChat,
    createSshServerChat,
    updateChat,
  } = useChats();
  const agents = useAgents();
  const {
    tasks,
    loading: tasksLoading,
    error: tasksError,
    refresh: refreshTasks,
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
    updateSession: updateStandaloneSession,
    deleteSession: deleteStandaloneSession,
  } = useSshServers();
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
  const fullTreePreference = useFileExplorerFullTreePreference();
  const privateItemsPreference = usePrivateItemsPreference();
  const dashboardData = useDashboardData();
  const provisioning = useProvisioningJob();
  const { workspaceGroups } = useTaskGrouping(tasks, workspaces, !workspacesLoading);
  const { workspaceGroups: allWorkspaceGroups } = useTaskGrouping(
    tasks,
    workspaces,
    !workspacesLoading,
    { includeArchivedWorkspaces: true },
  );

  const navigateWithinShell = useCallback((nextRoute: WebAppRoute) => {
    replaceWebAppRoute(nextRoute);
  }, []);
  const pullingLatestWorkspaceIdsRef = useRef<Set<string>>(new Set());
  const archivingWorkspaceIdsRef = useRef<Set<string>>(new Set());
  const [pullingLatestWorkspaceIds, setPullingLatestWorkspaceIds] = useState<ReadonlySet<string>>(() => new Set());
  const [archivingWorkspaceIds, setArchivingWorkspaceIds] = useState<ReadonlySet<string>>(() => new Set());

  const focusSidebarSearch = useCallback(() => {
    document.querySelector<HTMLButtonElement>('button[aria-label="Show sidebar"]')?.click();
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>("#wapp-sidebar input")?.focus();
    });
  }, []);

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
    workspaceGroups: allWorkspaceGroups,
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

  const toggleWorkspaceArchived = useCallback(async (workspace: Workspace): Promise<void> => {
    if (archivingWorkspaceIdsRef.current.has(workspace.id)) {
      return;
    }

    archivingWorkspaceIdsRef.current.add(workspace.id);
    setArchivingWorkspaceIds(new Set(archivingWorkspaceIdsRef.current));

    const nextArchivedState = workspace.archived !== true;
    const archiveUpdateRequest = { archived: nextArchivedState };
    try {
      const updated = await updateWorkspace(workspace.id, archiveUpdateRequest);
      if (!updated) {
        toast.error(nextArchivedState ? "Failed to archive workspace" : "Failed to unarchive workspace");
        return;
      }
      toast.success(nextArchivedState ? "Workspace archived." : "Workspace unarchived.");
    } catch (error) {
      toast.error(String(error));
    } finally {
      archivingWorkspaceIdsRef.current.delete(workspace.id);
      setArchivingWorkspaceIds(new Set(archivingWorkspaceIdsRef.current));
    }
  }, [toast, updateWorkspace]);

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

  const shellLoading = chatsLoading || tasksLoading || sshSessionsLoading || sshServersLoading || workspacesLoading || agents.loading;
  const shellErrors = [chatsError, tasksError, sshSessionsError, sshServersError, workspaceError, agents.error].filter(
    Boolean,
  ) as string[];
  const {
    taskId,
    chatId,
    composeKind,
    selectedTask,
    selectedChat,
    selectedWorkspace,
    composeWorkspace,
    composeServer,
    selectedAgent,
  } = getShellRouteSelection(route, {
    tasks,
    chats,
    workspaces,
    servers,
    sessionsByServerId,
    agents: agents.agents,
  });
  const chatActions = useChatActions({
    chat: route.view === "chat" ? selectedChat : null,
    hasCodeExplorerAction: true,
    onOpenCodeExplorer: (chat) => navigateWithinShell({
      view: "code-explorer",
      contentType: "chat",
      chatId: chat.config.id,
    }),
    onTaskSpawned: (task) => navigateWithinShell({ view: "task", taskId: task.config.id }),
    onChatRenamed: refreshChats,
    onChatDeleted: () => navigateWithinShell({ view: "home" }),
    onActionError: (message) => toast.error(message),
  });
  const selectedChatActions = useMemo(() => chatActions.items, [chatActions.items]);
  const dialogs = useShellDialogComposition({
    route,
    navigateWithinShell,
    onError: toast.error,
    updateWorkspaceSshSession,
    updateStandaloneSession,
    refreshSshServers,
    deleteWorkspaceSshSession,
    deleteStandaloneSession,
    agents,
    createChat,
    quickChatSettings,
    quickChatWorkspace,
    chatActionModals: chatActions.modals,
  });

  const toggleTaskPrivate = useCallback(async (task: Task): Promise<void> => {
    const updated = await updateTask(task.config.id, { isPrivate: !task.config.isPrivate });
    if (!updated) {
      toast.error(task.config.isPrivate ? "Failed to unmark task as private" : "Failed to mark task as private");
    }
  }, [toast, updateTask]);

  const toggleChatPrivate = useCallback(async (chat: Chat): Promise<void> => {
    const updated = await updateChat(chat.config.id, { isPrivate: !chat.config.isPrivate });
    if (!updated) {
      toast.error(chat.config.isPrivate ? "Failed to unmark chat as private" : "Failed to mark chat as private");
    }
  }, [toast, updateChat]);

  const toggleAgentPrivate = useCallback(async (agent: Agent): Promise<void> => {
    const updated = await agents.updateAgent(agent.config.id, { isPrivate: !agent.config.isPrivate });
    if (!updated) {
      toast.error(agent.config.isPrivate ? "Failed to unmark agent as private" : "Failed to mark agent as private");
    }
  }, [agents, toast]);

  const toggleWorkspacePrivate = useCallback(async (workspace: Workspace): Promise<void> => {
    const updated = await updateWorkspace(workspace.id, { isPrivate: !workspace.isPrivate });
    if (!updated) {
      toast.error(workspace.isPrivate ? "Failed to unmark workspace as private" : "Failed to mark workspace as private");
    }
  }, [toast, updateWorkspace]);

  const toggleWorkspaceSshSessionPrivate = useCallback(async (session: SshSession): Promise<void> => {
    try {
      await updateWorkspaceSshSession(session.config.id, { isPrivate: !session.config.isPrivate });
    } catch (error) {
      toast.error(String(error));
    }
  }, [toast, updateWorkspaceSshSession]);

  const toggleSshServerPrivate = useCallback(async (server: SshServer): Promise<void> => {
    const updated = await updateServer(server.config.id, { isPrivate: !server.config.isPrivate });
    if (!updated) {
      toast.error(server.config.isPrivate ? "Failed to unmark SSH server as private" : "Failed to mark SSH server as private");
    }
  }, [toast, updateServer]);

  const toggleStandaloneSshSessionPrivate = useCallback(async (
    serverId: string,
    session: SshServerSession,
  ): Promise<void> => {
    try {
      await updateStandaloneSession(serverId, session.config.id, { isPrivate: !session.config.isPrivate });
    } catch (error) {
      toast.error(String(error));
    }
  }, [toast, updateStandaloneSession]);

  const stopSidebarTask = useCallback(async (task: Task): Promise<void> => {
    try {
      const stopped = await stopTaskApi(task.config.id);
      if (!stopped) {
        toast.error("Failed to stop task");
        return;
      }
      await refreshTasks();
    } catch (error) {
      toast.error(String(error));
    }
  }, [refreshTasks, toast]);

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

  const routes = useMemo(() => buildShellRoutes({
    shellLoading,
    shellErrors,
    navigateWithinShell,
    tasks,
    chats,
    workspaces,
    sessions,
    servers,
    sessionsByServerId,
    serverNodes,
    workspaceGroups,
    sidebarWorkspaceGroups,
    workspacesLoading,
    workspacesSaving,
    workspaceError,
    refreshTasks,
    refreshChats,
    purgeTask,
    refreshSshSessions,
    refreshSshServers,
    refreshWorkspaces,
    createSession,
    createStandaloneSession,
    createServer,
    updateServer,
    deleteServer,
    deleteWorkspace,
    dashboardData,
    schedulerTimezone: schedulerTimezone.timezone,
    agents,
    editingAgentId: dialogs.editingAgentId,
    onCancelAgentEdit: dialogs.cancelAgentEdit,
    onSavedAgentEdit: dialogs.handleAgentSaved,
    composeActionState: composeState.composeActionState,
    setComposeActionState: composeState.setComposeActionState,
    handleTaskSubmit: composeState.handleTaskSubmit,
    createChat,
    importExistingChat,
    createSshServerChat,
    workspaceCreate,
    workspaceSettings,
    provisioning,
    toast,
    showPrivateItems: privateItemsPreference.showPrivateItems,
  } satisfies ShellRouteCompositionContext), [
    agents,
    dialogs.cancelAgentEdit,
    chats,
    composeState.composeActionState,
    composeState.handleTaskSubmit,
    composeState.setComposeActionState,
    createChat,
    createServer,
    createSession,
    createSshServerChat,
    createStandaloneSession,
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
    refreshSshServers,
    refreshSshSessions,
    refreshTasks,
    refreshWorkspaces,
    schedulerTimezone.timezone,
    serverNodes,
    servers,
    sessions,
    sessionsByServerId,
    shellErrors,
    shellLoading,
    sidebarWorkspaceGroups,
    tasks,
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
    markdownPreference,
    fullTreePreference,
    privateItemsPreference,
    dashboardData,
    workspaces,
    workspacesLoading,
    refreshTasks,
  }), [
    dashboardData,
    fullTreePreference,
    markdownPreference,
    privateItemsPreference,
    quickChatSettings,
    refreshTasks,
    schedulerTimezone,
    workspaces,
    workspacesLoading,
  ]);

  const sidebarComposition = useMemo(() => buildShellSidebarComposition({
    sidebarWorkspaceGroups,
    serverNodes,
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
      toggleAgentPrivate,
      toggleWorkspacePrivate,
      toggleWorkspaceSshSessionPrivate,
      toggleSshServerPrivate,
      toggleStandaloneSshSessionPrivate,
      stopSidebarTask,
      openRenameSshSession: dialogs.openRenameSshSession,
      openDeleteSshSession: dialogs.openDeleteSshSession,
      pullLatestWorkspaceChanges,
      pullingLatestWorkspaceIds,
      toggleWorkspaceArchived,
      archivingWorkspaceIds,
      setEditingAgentId: dialogs.setEditingAgentId,
      setDeleteAgentTarget: dialogs.setDeleteAgentTarget,
      setPurgeAgentTarget: dialogs.setPurgeAgentTarget,
      agents,
      showPrivateItems: privateItemsPreference.showPrivateItems,
    } satisfies ShellSidebarActionHandlers,
    quickChatUnavailableReason,
    quickChatCreating: dialogs.quickChatCreating,
    onQuickChat: () => void dialogs.handleQuickChat(),
  }), [
    agents,
    archivingWorkspaceIds,
    dialogs.handleQuickChat,
    navigateWithinShell,
    dialogs.openDeleteSshSession,
    dialogs.openRenameSshSession,
    privateItemsPreference.showPrivateItems,
    pullLatestWorkspaceChanges,
    pullingLatestWorkspaceIds,
    dialogs.quickChatCreating,
    quickChatUnavailableReason,
    route,
    selectedChat,
    selectedChatActions,
    serverNodes,
    dialogs.setDeleteAgentTarget,
    dialogs.setEditingAgentId,
    dialogs.setPurgeAgentTarget,
    sidebarWorkspaceGroups,
    stopSidebarTask,
    toast,
    toggleAgentPrivate,
    toggleChatPrivate,
    toggleSshServerPrivate,
    toggleStandaloneSshSessionPrivate,
    toggleTaskPrivate,
    toggleWorkspaceArchived,
    toggleWorkspacePrivate,
    toggleWorkspaceSshSessionPrivate,
    workspaces,
  ]);
  const headerNodes = sidebarComposition.headerNodes;
  const headerOwnerRoute = useMemo(() => getHeaderOwnerRoute(route), [route]);
  const headerNode = useMemo(
    () => headerOwnerRoute
      ? headerNodes.find((node) => sidebarNodeMatchesRoute(node, headerOwnerRoute)) ?? null
      : null,
    [headerNodes, headerOwnerRoute],
  );
  const headerModel = useMemo<HeaderModel>(() => {
    const nodeModel: HeaderModel | null = headerNode
      ? {
          title: headerNode.title,
          subtitle: headerNode.subtitle,
          badge: headerNode.badge,
          badgeVariant: headerNode.badgeVariant,
        }
      : null;

    switch (route.view) {
      case "home":
        return { title: "Clanky" };
      case "task":
        if (taskId && !selectedTask && !tasksLoading) {
          return { title: "Task not found" };
        }
        return selectedTask?.state.status === "draft" && nodeModel
          ? { ...nodeModel, title: `Edit ${nodeModel.title}` }
          : nodeModel ?? { title: "Task" };
      case "task-files":
        return nodeModel
          ? { title: nodeModel.title, subtitle: `Files${nodeModel.subtitle ? ` · ${nodeModel.subtitle}` : ""}` }
          : { title: "Task files" };
      case "chat":
        if (chatId && !selectedChat && !chatsLoading) {
          return { title: "Chat not found" };
        }
        return nodeModel ?? { title: "Chat" };
      case "chat-transcript":
        return nodeModel
          ? { title: nodeModel.title, subtitle: "Transcript" }
          : { title: "Chat transcript" };
      case "ssh":
        return nodeModel ?? { title: "SSH session" };
      case "workspace":
        return nodeModel ?? { title: "Workspace" };
      case "workspace-files":
        return nodeModel
          ? { title: nodeModel.title, subtitle: `Files${nodeModel.subtitle ? ` · ${nodeModel.subtitle}` : ""}` }
          : { title: "Workspace files" };
      case "workspace-previews":
        return nodeModel
          ? { title: nodeModel.title, subtitle: `Live previews${nodeModel.subtitle ? ` · ${nodeModel.subtitle}` : ""}` }
          : { title: "Live previews" };
      case "workspace-settings":
        return nodeModel
          ? { title: nodeModel.title, subtitle: `Workspace settings${nodeModel.subtitle ? ` · ${nodeModel.subtitle}` : ""}` }
          : { title: "Workspace settings" };
      case "ssh-server":
        return nodeModel ?? { title: "SSH server" };
      case "vnc-session":
        return nodeModel
          ? { title: nodeModel.title, subtitle: `VNC session${nodeModel.subtitle ? ` · ${nodeModel.subtitle}` : ""}` }
          : { title: "VNC session" };
      case "ssh-server-settings":
        return nodeModel
          ? { title: nodeModel.title, subtitle: `SSH server settings${nodeModel.subtitle ? ` · ${nodeModel.subtitle}` : ""}` }
          : { title: "SSH server settings" };
      case "server-files":
        return nodeModel
          ? { title: nodeModel.title, subtitle: `Files${nodeModel.subtitle ? ` · ${nodeModel.subtitle}` : ""}` }
          : { title: "Server files" };
      case "server-arise":
        return nodeModel ? { title: `Arise ${nodeModel.title}` } : { title: "Arise" };
      case "agent": {
        const agentId = getRouteString(route, "agentId");
        if (agentId && !selectedAgent && !agents.loading) {
          return { title: "Agent not found" };
        }
        const agent = selectedAgent;
        return dialogs.editingAgentId && dialogs.editingAgentId === agentId
          ? { title: `Edit agent ${agent?.config.name ?? nodeModel?.title ?? ""}`.trim() }
          : nodeModel ?? { title: "Agent" };
      }
      case "agent-run": {
        const agentId = getRouteString(route, "agentId");
        const runId = getRouteString(route, "runId");
        const agent = selectedAgent;
        const run = agentId && runId
          ? (agents.runsByAgentId[agentId] ?? []).find((item) => item.id === runId)
          : null;
        return {
          title: agent?.config.name ?? run?.configSnapshot.name ?? "Agent run",
          subtitle: run ? `Run · ${run.status}` : "Agent run",
        };
      }
      case "agents": {
        const workspaceId = getRouteString(route, "workspaceId");
        const workspace = workspaceId ? workspaces.find((item) => item.id === workspaceId) : null;
        return {
          title: workspace ? `Agents in ${workspace.name}` : "Agents",
          subtitle: workspace?.directory,
        };
      }
      case "code-explorer":
        return {
          title: "Code Explorer",
          subtitle: headerNode?.title,
        };
      case "compose": {
        const kind = composeKind;
        if (kind === "task") {
          return {
            title: composeWorkspace ? `Start a new task in ${composeWorkspace.name}` : "Start a new task",
            subtitle: composeWorkspace?.directory,
          };
        }
        if (kind === "chat" || kind === "ssh-server-chat") {
          return {
            title: composeServer
              ? `Start a new chat on ${composeServer.config.name}`
              : composeWorkspace ? `Start a new chat in ${composeWorkspace.name}` : "Start a new chat",
            subtitle: composeServer
              ? `${composeServer.config.username}@${composeServer.config.address}`
              : composeWorkspace?.directory,
          };
        }
        if (kind === "agent") {
          return {
            title: composeWorkspace ? `Start a new agent in ${composeWorkspace.name}` : "Start a new agent",
            subtitle: composeWorkspace?.directory,
          };
        }
        if (kind === "workspace") {
          return { title: "Create a workspace" };
        }
        if (kind === "ssh-session") {
          return { title: "Create an SSH session" };
        }
        if (kind === "ssh-server") {
          return {
            title: composeServer ? `Edit ${composeServer.config.name}` : "Register a standalone SSH server",
            subtitle: composeServer ? "Update the saved host metadata and optional client-only password." : undefined,
          };
        }
        return { title: "Compose" };
      }
      case "rebuild-workspace":
        return selectedWorkspace ? { title: `Rebuild ${selectedWorkspace.name}` } : { title: "Rebuild workspace" };
      case "restart-workspace":
        return selectedWorkspace ? { title: `Restart ${selectedWorkspace.name}` } : { title: "Restart workspace" };
      default:
        return { title: route.view.replace(/-/g, " ") };
    }
  }, [
    agents.agents,
    agents.loading,
    agents.runsByAgentId,
    chatId,
    chatsLoading,
    composeKind,
    composeServer,
    composeWorkspace,
    dialogs.editingAgentId,
    headerNode,
    route,
    selectedAgent,
    selectedChat,
    selectedTask,
    selectedWorkspace,
    taskId,
    tasksLoading,
    workspaces,
  ]);
  const headerActions = useMemo<ActionMenuItem[]>(() => {
    const ownerActions = headerNode?.actions ?? [];
    if (route.view === "agent-run") {
      const agentId = getRouteString(route, "agentId");
      return [
        {
          id: "back-to-agent",
          label: "Back",
          onAction: () => navigateWithinShell(agentId ? { view: "agent", agentId } : HOME_ROUTE),
        },
        ...ownerActions,
      ];
    }
    if (headerOwnerRoute && headerNode && !sidebarNodeMatchesRoute(headerNode, route)) {
      return ownerActions;
    }
    return [];
  }, [headerNode, headerOwnerRoute, navigateWithinShell, route]);

  return (
    <>
      <WebAppRoot
        appName="Clanky"
        homeRoute={HOME_ROUTE}
        sidebar={sidebarComposition.sidebar}
        routes={routes}
        onRouteChange={handleWebRouteChange}
        header={{
          renderTitle: () => <RouteHeaderTitle model={headerModel} />,
          getActions: () => headerActions,
        }}
        settings={{ sections: settingsSections }}
        version={dashboardData.version ?? undefined}
      />
      {dialogs.modals}
    </>
  );
}

export default AppShell;
