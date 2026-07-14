import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ConfirmModal,
  Modal,
  Page,
  replaceWebAppRoute,
  WebAppRoot,
  type ActionMenuItem,
  type SidebarNode,
  type WebAppRoute,
  type WebAppRootProps,
} from "@pablozaiden/webapp/web";
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
  useToast,
  useWorkspaces,
  stopTaskApi,
} from "../../hooks";
import type { QuickChatSettings } from "@/shared/preferences";
import {
  buildActiveWorkSidebarItems,
  buildServerSidebarNodes,
  buildWorkspaceSidebarGroups,
} from "./shell-types";
import { AppRouteContent } from "./shell-main-content";
import { getRouteString } from "./route-fields";
import { getShellShortcutForKeyboardEvent, isEditableShortcutTarget } from "./shell-shortcuts";
import { useWorkspaceCreate } from "./use-workspace-create";
import { useWorkspaceSettingsShell } from "./use-workspace-settings-shell";
import { useComposeState } from "./use-compose-state";
import {
  DangerZoneSection,
  ContentPreferencesSection,
  PrivateItemsSection,
  QuickChatSettingsSection,
  SchedulerSettingsSection,
} from "../app-settings";
import { useChatActions } from "./chat-actions";
import { normalizeGitHubRepositoryUrl } from "../../lib/github-repository-url";
import { appFetch } from "../../lib/public-path";
import type { Agent, Chat, SshServer, SshServerSession, SshSession, Task, Workspace } from "@/shared";
import type { GitHubRepositoryUrlResponse } from "@/contracts";
import { RenameSshSessionModal } from "../RenameSshSessionModal";
import {
  isEffectivelyPrivate,
  privateSidebarPresentation,
  shouldObscurePrivateItem,
  type PrivateEntity,
  type PrivateSidebarNode,
} from "../../lib/private-items";
import { StandaloneChatTranscriptViewer } from "../StandaloneChatTranscriptViewer";
import { ShellPanel } from "./shell-panel";
import { StatusBadge } from "../common";
import { isTaskActive, isTaskGenerating } from "../../utils";

type SshSessionActionTarget =
  | { kind: "workspace"; id: string; name: string }
  | { kind: "standalone"; id: string; name: string; serverId: string };

type SearchableSidebarNode = PrivateSidebarNode & {
  searchText?: string;
};

const ROUTE_VIEWS = [
  "home",
  "agents",
  "agent",
  "agent-run",
  "code-explorer",
  "task",
  "task-files",
  "chat",
  "chat-transcript",
  "ssh",
  "workspace",
  "workspace-files",
  "workspace-previews",
  "workspace-settings",
  "ssh-server",
  "vnc-session",
  "ssh-server-settings",
  "server-files",
  "server-arise",
  "compose",
  "rebuild-workspace",
  "restart-workspace",
] as const;

const HOME_ROUTE: WebAppRoute = { view: "home" };

function sidebarActionItems(items: Array<{ id?: string; label: string; disabled?: boolean; destructive?: boolean; onClick: () => void }>): ActionMenuItem[] {
  return items.map((item) => ({
    id: item.id,
    label: item.label,
    disabled: item.disabled,
    destructive: item.destructive,
    onAction: item.onClick,
  }));
}

async function openWorkspaceGitHubUrl(workspace: Workspace, onError: (message: string) => void): Promise<void> {
  const persistedUrl = normalizeGitHubRepositoryUrl(workspace.repoUrl ?? "");
  if (persistedUrl) {
    window.open(persistedUrl, "_blank", "noopener,noreferrer");
    return;
  }

  const response = await appFetch(
    `/api/git/github-repository-url?workspaceId=${encodeURIComponent(workspace.id)}`,
  );
  if (!response.ok) {
    onError("GitHub repository URL is not available for this workspace");
    return;
  }

  const data = await response.json() as GitHubRepositoryUrlResponse;
  if (!data.githubUrl) {
    onError("GitHub repository URL is not available for this workspace");
    return;
  }

  window.open(data.githubUrl, "_blank", "noopener,noreferrer");
}

function withPrivateToggleAction(
  items: ActionMenuItem[],
  entity: PrivateEntity,
  onToggle: () => void,
): ActionMenuItem[] {
  return [
    ...items,
    {
      id: entity.isPrivate ? "unmark-private" : "mark-private",
      label: entity.isPrivate ? "Unmark private" : "Mark as private",
      onAction: onToggle,
    },
  ];
}

function privateActions(
  items: ActionMenuItem[],
  privateHidden: boolean,
  selfPrivate: boolean,
): ActionMenuItem[] {
  if (!privateHidden) {
    return items;
  }
  if (!selfPrivate) {
    return [];
  }
  return items.filter((item) => item.id === "unmark-private");
}

function filterSidebarNodes(nodes: SearchableSidebarNode[], search: string): SidebarNode[] {
  const normalized = search.trim().toLowerCase();
  if (!normalized) {
    return nodes;
  }

  const matches = (node: SearchableSidebarNode) => {
    if (node.privateHidden) {
      return false;
    }
    return `${node.title} ${node.subtitle ?? ""} ${node.searchText ?? ""}`.toLowerCase().includes(normalized);
  };
  return nodes.flatMap((node) => {
    const children = node.children ? filterSidebarNodes(node.children as SearchableSidebarNode[], search) : undefined;
    const childMatches = children !== undefined && children.length > 0;
    if (childMatches || (node.type !== "section" && matches(node))) {
      return [{ ...node, children, defaultCollapsed: false }];
    }
    return [];
  });
}

function flattenSidebarNodes(nodes: SidebarNode[]): SidebarNode[] {
  return nodes.flatMap((node) => [
    node,
    ...(node.children ? flattenSidebarNodes(node.children) : []),
  ]);
}

function sidebarNodeMatchesRoute(node: SidebarNode, route: WebAppRoute): boolean {
  if (!node.route || node.route.view !== route.view) {
    return false;
  }
  return Object.entries(node.route).every(([key, value]) => route[key] === value);
}

function getHeaderOwnerRoute(route: WebAppRoute): WebAppRoute | null {
  switch (route.view) {
    case "task":
      return getRouteString(route, "taskId")
        ? { view: "task", taskId: getRouteString(route, "taskId")! }
        : null;
    case "task-files":
      return getRouteString(route, "taskId")
        ? { view: "task", taskId: getRouteString(route, "taskId")! }
        : null;
    case "chat":
    case "chat-transcript":
      return getRouteString(route, "chatId")
        ? { view: "chat", chatId: getRouteString(route, "chatId")! }
        : null;
    case "ssh":
      return getRouteString(route, "sshSessionId")
        ? { view: "ssh", sshSessionId: getRouteString(route, "sshSessionId")! }
        : null;
    case "workspace":
    case "workspace-files":
    case "workspace-previews":
    case "workspace-settings":
    case "rebuild-workspace":
    case "restart-workspace":
      return getRouteString(route, "workspaceId")
        ? { view: "workspace", workspaceId: getRouteString(route, "workspaceId")! }
        : null;
    case "ssh-server":
    case "vnc-session":
    case "ssh-server-settings":
    case "server-files":
    case "server-arise":
      return getRouteString(route, "serverId")
        ? { view: "ssh-server", serverId: getRouteString(route, "serverId")! }
        : null;
    case "agent":
    case "agent-run":
      return getRouteString(route, "agentId")
        ? { view: "agent", agentId: getRouteString(route, "agentId")! }
        : null;
    case "code-explorer": {
      const contentType = getRouteString(route, "contentType");
      if (contentType === "task" && getRouteString(route, "taskId")) {
        return { view: "task", taskId: getRouteString(route, "taskId")! };
      }
      if (contentType === "chat" && getRouteString(route, "chatId")) {
        return { view: "chat", chatId: getRouteString(route, "chatId")! };
      }
      if (contentType === "workspace" && getRouteString(route, "workspaceId")) {
        return { view: "workspace", workspaceId: getRouteString(route, "workspaceId")! };
      }
      if (contentType === "server" && getRouteString(route, "serverId")) {
        return { view: "ssh-server", serverId: getRouteString(route, "serverId")! };
      }
      return null;
    }
    default:
      return null;
  }
}

interface HeaderModel {
  title: string;
  subtitle?: string;
  badge?: string;
  badgeVariant?: SidebarNode["badgeVariant"];
}

function RouteHeaderTitle({ model }: { model: HeaderModel }) {
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
  const [renameSshSessionTarget, setRenameSshSessionTarget] = useState<SshSessionActionTarget | null>(null);
  const [deleteSshSessionTarget, setDeleteSshSessionTarget] = useState<SshSessionActionTarget | null>(null);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [deleteAgentTarget, setDeleteAgentTarget] = useState<Agent | null>(null);
  const [deleteAgentPending, setDeleteAgentPending] = useState(false);
  const [purgeAgentTarget, setPurgeAgentTarget] = useState<Agent | null>(null);
  const [purgeAgentPending, setPurgeAgentPending] = useState(false);

  const focusSidebarSearch = useCallback(() => {
    document.querySelector<HTMLButtonElement>('button[aria-label="Show sidebar"]')?.click();
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>("#wapp-sidebar input")?.focus();
    });
  }, []);

  const openRenameSshSession = useCallback((target: SshSessionActionTarget) => {
    setRenameSshSessionTarget(target);
  }, []);

  const openDeleteSshSession = useCallback((target: SshSessionActionTarget) => {
    setDeleteSshSessionTarget(target);
  }, []);

  const renameSshSession = useCallback(async (newName: string): Promise<void> => {
    if (!renameSshSessionTarget) {
      return;
    }
    if (renameSshSessionTarget.kind === "workspace") {
      await updateWorkspaceSshSession(renameSshSessionTarget.id, { name: newName });
    } else {
      await updateStandaloneSession(renameSshSessionTarget.serverId, renameSshSessionTarget.id, { name: newName });
      await refreshSshServers();
    }
    setRenameSshSessionTarget(null);
  }, [refreshSshServers, renameSshSessionTarget, updateStandaloneSession, updateWorkspaceSshSession]);

  const deleteSshSession = useCallback(async (): Promise<void> => {
    if (!deleteSshSessionTarget) {
      return;
    }
    const success = deleteSshSessionTarget.kind === "workspace"
      ? await deleteWorkspaceSshSession(deleteSshSessionTarget.id)
      : await deleteStandaloneSession(deleteSshSessionTarget.serverId, deleteSshSessionTarget.id);
    if (!success) {
      toast.error("Failed to delete SSH session.");
      return;
    }
    const deletedActiveSession = route.view === "ssh"
      && getRouteString(route, "sshSessionId") === deleteSshSessionTarget.id;
    setDeleteSshSessionTarget(null);
    if (deletedActiveSession) {
      navigateWithinShell({ view: "home" });
    }
  }, [deleteSshSessionTarget, deleteStandaloneSession, deleteWorkspaceSshSession, navigateWithinShell, route, toast]);

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

  const shellLoading = chatsLoading || tasksLoading || sshSessionsLoading || sshServersLoading || workspacesLoading || agents.loading;
  const shellErrors = [chatsError, tasksError, sshSessionsError, sshServersError, workspaceError, agents.error].filter(
    Boolean,
  ) as string[];
  const codeExplorerContentType = route.view === "code-explorer" ? route["contentType"] : undefined;
  const codeExplorerTaskId = codeExplorerContentType === "task"
    ? getRouteString(route, "taskId")
    : null;
  const codeExplorerChatId = codeExplorerContentType === "chat"
    ? getRouteString(route, "chatId")
    : null;
  const codeExplorerWorkspaceId = codeExplorerContentType === "workspace"
    ? getRouteString(route, "workspaceId")
    : null;
  const codeExplorerServerId = codeExplorerContentType === "server"
    ? getRouteString(route, "serverId")
    : null;
  const taskId = getRouteString(route, "taskId");
  const chatId = getRouteString(route, "chatId");
  const workspaceId = getRouteString(route, "workspaceId");
  const serverId = getRouteString(route, "serverId");
  const composeKind = route.view === "compose" ? getRouteString(route, "kind") : undefined;
  const composeScopeId = route.view === "compose" ? getRouteString(route, "scopeId") : undefined;

  const selectedTask =
    route.view === "task" || route.view === "task-files"
      ? (taskId ? (tasks.find((task) => task.config.id === taskId) ?? null) : null)
      : codeExplorerTaskId
        ? (tasks.find((task) => task.config.id === codeExplorerTaskId) ?? null)
      : null;
  const selectedChat =
    route.view === "chat"
      ? (chatId ? (chats.find((chat) => chat.config.id === chatId) ?? null) : null)
      : codeExplorerChatId
        ? (chats.find((chat) => chat.config.id === codeExplorerChatId) ?? null)
        : null;
  const selectedWorkspace =
    route.view === "workspace"
      || route.view === "workspace-files"
      || route.view === "workspace-previews"
      || route.view === "workspace-settings"
      || route.view === "rebuild-workspace"
      || route.view === "restart-workspace"
      ? (workspaceId ? (workspaces.find((w) => w.id === workspaceId) ?? null) : null)
      : codeExplorerWorkspaceId
        ? (workspaces.find((w) => w.id === codeExplorerWorkspaceId) ?? null)
        : codeExplorerTaskId
          ? (workspaces.find((w) => w.id === selectedTask?.config.workspaceId) ?? null)
          : codeExplorerChatId
            ? (workspaces.find((w) => w.id === selectedChat?.config.workspaceId) ?? null)
            : null;
  const composeWorkspace =
    route.view === "compose" && composeKind !== "ssh-server" && composeKind !== "ssh-server-chat"
      ? (workspaces.find((w) => w.id === (workspaceId ?? composeScopeId)) ?? null)
      : null;
  const composeServer =
    route.view === "compose" && (composeKind === "ssh-session" || composeKind === "ssh-server" || composeKind === "ssh-server-chat")
      ? (servers.find((s) => s.config.id === (serverId ?? composeScopeId)) ?? null)
      : null;
  const composeServerSessionCount = composeServer
    ? (sessionsByServerId[composeServer.config.id]?.length ?? 0)
    : 0;
  const selectedServer =
    route.view === "ssh-server"
      || route.view === "vnc-session"
      || route.view === "ssh-server-settings"
      || route.view === "server-files"
      || route.view === "server-arise"
      ? (serverId ? (servers.find((s) => s.config.id === serverId) ?? null) : null)
      : codeExplorerServerId
        ? (servers.find((s) => s.config.id === codeExplorerServerId) ?? null)
        : null;
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

  const getChatSidebarActions = useCallback((chat: Chat): ActionMenuItem[] => {
    const chatId = chat.config.id;
    const baseActions = route.view === "chat" && selectedChat?.config.id === chatId
      ? selectedChatActions
      : sidebarActionItems([
        {
          id: "open-code-explorer",
          label: "Open code explorer",
          onClick: () => navigateWithinShell({ view: "code-explorer", contentType: "chat", chatId }),
        },
      ]);
    return withPrivateToggleAction(baseActions, chat.config, () => void toggleChatPrivate(chat));
  }, [navigateWithinShell, route.view, selectedChat?.config.id, selectedChatActions, toggleChatPrivate]);

  const getTaskSidebarActions = useCallback((task: Task): ActionMenuItem[] => {
    const stopAction = isTaskGenerating(task) && (isTaskActive(task.state.status) || task.state.status === "planning")
      ? [{
          id: "stop-task",
          label: "Stop task",
          onClick: () => void stopSidebarTask(task),
        }]
      : [];
    return withPrivateToggleAction(sidebarActionItems([
      {
        id: "open-code-explorer",
        label: "Open code explorer",
        onClick: () => navigateWithinShell({ view: "code-explorer", contentType: "task", taskId: task.config.id }),
      },
      ...stopAction,
    ]), task.config, () => void toggleTaskPrivate(task));
  }, [navigateWithinShell, stopSidebarTask, toggleTaskPrivate]);

  const getWorkspaceSidebarActions = useCallback((workspaceNode: (typeof sidebarWorkspaceGroups)[number]["workspaces"][number]): ActionMenuItem[] => {
    const workspaceId = workspaceNode.workspace.id;
    const workspaceArchived = workspaceNode.workspace.archived === true;
    const workspaceArchiving = archivingWorkspaceIds.has(workspaceId);
    return withPrivateToggleAction(sidebarActionItems([
      { id: "new-task", label: "New Task", onClick: () => navigateWithinShell({ view: "compose", kind: "task", scopeId: workspaceId }) },
      { id: "new-chat", label: "New Chat", onClick: () => navigateWithinShell({ view: "compose", kind: "chat", scopeId: workspaceId }) },
      { id: "new-agent", label: "New Agent", onClick: () => navigateWithinShell({ view: "compose", kind: "agent", workspaceId }) },
      {
        id: "open-code-explorer",
        label: "Open code explorer",
        onClick: () => navigateWithinShell({ view: "code-explorer", contentType: "workspace", workspaceId }),
      },
      { id: "workspace-previews", label: "Previews", onClick: () => navigateWithinShell({ view: "workspace-previews", workspaceId }) },
      {
        id: "pull-latest-changes",
        label: pullingLatestWorkspaceIds.has(workspaceId) ? "Pulling Latest Changes..." : "Pull Latest Changes",
        disabled: pullingLatestWorkspaceIds.has(workspaceId),
        onClick: () => void pullLatestWorkspaceChanges(workspaceId),
      },
      {
        id: "open-github",
        label: "Open in GitHub",
        onClick: () => void openWorkspaceGitHubUrl(workspaceNode.workspace, (message) => toast.error(message)),
      },
      ...(workspaceNode.workspace.serverSettings.agent.transport === "ssh"
        ? [{ id: "new-ssh-session", label: "New SSH Session", onClick: () => navigateWithinShell({ view: "compose", kind: "ssh-session", workspaceId }) }]
        : []),
      {
        id: workspaceArchived ? "unarchive-workspace" : "archive-workspace",
        label: workspaceArchiving
          ? (workspaceArchived ? "Unarchiving Workspace..." : "Archiving Workspace...")
          : (workspaceArchived ? "Unarchive Workspace" : "Archive Workspace"),
        disabled: workspaceArchiving,
        onClick: () => void toggleWorkspaceArchived(workspaceNode.workspace),
      },
      { id: "workspace-settings", label: "Workspace Settings", onClick: () => navigateWithinShell({ view: "workspace-settings", workspaceId }) },
    ]), workspaceNode.workspace, () => void toggleWorkspacePrivate(workspaceNode.workspace));
  }, [
    archivingWorkspaceIds,
    navigateWithinShell,
    pullLatestWorkspaceChanges,
    pullingLatestWorkspaceIds,
    toast,
    toggleWorkspaceArchived,
    toggleWorkspacePrivate,
  ]);

  const getSshServerSidebarActions = useCallback((server: SshServer): ActionMenuItem[] => {
    const serverId = server.config.id;
    return withPrivateToggleAction(sidebarActionItems([
      {
        id: "open-code-explorer",
        label: "Open code explorer",
        onClick: () => navigateWithinShell({ view: "code-explorer", contentType: "server", serverId }),
      },
      { id: "new-session", label: "New Session", onClick: () => navigateWithinShell({ view: "compose", kind: "ssh-session", serverId }) },
      { id: "new-chat", label: "New Chat", onClick: () => navigateWithinShell({ view: "compose", kind: "ssh-server-chat", scopeId: serverId }) },
      { id: "start-vnc-session", label: "Start VNC Session", onClick: () => navigateWithinShell({ view: "vnc-session", serverId }) },
      { id: "ssh-server-settings", label: "SSH Server Settings", onClick: () => navigateWithinShell({ view: "ssh-server-settings", serverId }) },
    ]), server.config, () => void toggleSshServerPrivate(server));
  }, [navigateWithinShell, toggleSshServerPrivate]);

  const getSshSessionSidebarActions = useCallback((target: SshSessionActionTarget, session: SshSession | SshServerSession): ActionMenuItem[] => {
    const baseActions = sidebarActionItems([
      { id: "rename-ssh-session", label: "Rename", onClick: () => openRenameSshSession(target) },
      { id: "delete-ssh-session", label: "Delete Session", destructive: true, onClick: () => openDeleteSshSession(target) },
    ]);
    return withPrivateToggleAction(baseActions, session.config, () => {
      if (target.kind === "workspace") {
        void toggleWorkspaceSshSessionPrivate(session as SshSession);
        return;
      }
      void toggleStandaloneSshSessionPrivate(target.serverId, session as SshServerSession);
    });
  }, [
    openDeleteSshSession,
    openRenameSshSession,
    toggleStandaloneSshSessionPrivate,
    toggleWorkspaceSshSessionPrivate,
  ]);

  const getAgentSidebarActions = useCallback((agent: Agent): ActionMenuItem[] => {
    return withPrivateToggleAction(sidebarActionItems([
      { id: "edit-agent", label: "Edit", onClick: () => setEditingAgentId(agent.config.id) },
      {
        id: "toggle-agent-paused",
        label: agent.config.enabled ? "Pause" : "Resume",
        onClick: () => {
          const request = agent.config.enabled ? agents.pauseAgent(agent.config.id) : agents.resumeAgent(agent.config.id);
          void request.then((updated) => {
            if (!updated) {
              toast.error(agent.config.enabled ? "Failed to pause agent" : "Failed to resume agent");
            }
          });
        },
      },
      agent.state.status === "running"
        ? { id: "interrupt-agent", label: "Interrupt", onClick: () => void agents.interruptAgent(agent.config.id) }
        : { id: "run-agent", label: "Run now", onClick: () => void agents.runAgent(agent.config.id) },
      { id: "purge-agent-runs", label: "Purge runs", destructive: true, onClick: () => setPurgeAgentTarget(agent) },
      { id: "delete-agent", label: "Delete", destructive: true, onClick: () => setDeleteAgentTarget(agent) },
    ]), agent.config, () => void toggleAgentPrivate(agent));
  }, [agents, toast, toggleAgentPrivate]);

  const getPrivateHidden = useCallback((
    entity: PrivateEntity | null | undefined,
    ancestors: Array<PrivateEntity | null | undefined> = [],
  ): boolean => {
    return shouldObscurePrivateItem(
      isEffectivelyPrivate(entity, ancestors),
      privateItemsPreference.showPrivateItems,
    );
  }, [privateItemsPreference.showPrivateItems]);

  const cancelAgentEdit = useCallback(() => {
    setEditingAgentId(null);
  }, []);

  const handleAgentSaved = useCallback((savedAgent: Agent) => {
    setEditingAgentId(null);
    navigateWithinShell({ view: "agent", agentId: savedAgent.config.id });
  }, [navigateWithinShell]);

  const deleteAgent = useCallback(async (): Promise<void> => {
    if (!deleteAgentTarget) {
      return;
    }
    setDeleteAgentPending(true);
    try {
      const deleted = await agents.deleteAgent(deleteAgentTarget.config.id);
      if (!deleted) {
        toast.error("Failed to delete agent");
        return;
      }
      const deletedActiveAgent = route.view === "agent"
        && getRouteString(route, "agentId") === deleteAgentTarget.config.id;
      setDeleteAgentTarget(null);
      if (deletedActiveAgent) {
        navigateWithinShell({ view: "agents", workspaceId: deleteAgentTarget.config.workspaceId });
      }
    } finally {
      setDeleteAgentPending(false);
    }
  }, [agents, deleteAgentTarget, navigateWithinShell, route, toast]);

  const purgeAgentRuns = useCallback(async (): Promise<void> => {
    if (!purgeAgentTarget) {
      return;
    }
    setPurgeAgentPending(true);
    try {
      await agents.purgeRuns(purgeAgentTarget.config.id);
      setPurgeAgentTarget(null);
    } finally {
      setPurgeAgentPending(false);
    }
  }, [agents, purgeAgentTarget]);

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
        useWorktree: settings.useWorktree,
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

  const renderRouteContent = useCallback((webRoute: WebAppRoute) => {
    if (webRoute.view === "chat-transcript") {
      const transcriptChatId = getRouteString(webRoute, "chatId");
      return (
        <Page layout="full">
          {transcriptChatId
            ? <StandaloneChatTranscriptViewer chatId={transcriptChatId} />
            : (
              <ShellPanel
                title="Chat transcript not found"
                description="The transcript route is missing a chat identifier."
                variant="compact"
              >
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Use the sidebar or home button to continue.
                </p>
              </ShellPanel>
            )}
        </Page>
      );
    }

    return (
      <AppRouteContent
        route={webRoute}
        shellLoading={shellLoading}
        shellErrors={shellErrors}
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
        dashboardData={dashboardData}
        schedulerTimezone={schedulerTimezone.timezone}
        agents={agents}
        editingAgentId={editingAgentId}
        onCancelAgentEdit={cancelAgentEdit}
        onSavedAgentEdit={handleAgentSaved}
        composeActionState={composeState.composeActionState}
        setComposeActionState={composeState.setComposeActionState}
        handleTaskSubmit={composeState.handleTaskSubmit}
        createChat={createChat}
        importExistingChat={importExistingChat}
        createSshServerChat={createSshServerChat}
        workspaceCreate={workspaceCreate}
        workspaceSettings={workspaceSettings}
        provisioning={provisioning}
        toast={toast}
        showPrivateItems={privateItemsPreference.showPrivateItems}
      />
    );
  }, [
    agents,
    cancelAgentEdit,
    chats,
    composeServer,
    composeServerSessionCount,
    composeState.composeActionState,
    composeState.handleTaskSubmit,
    composeState.setComposeActionState,
    composeWorkspace,
    createChat,
    createServer,
    createSession,
    createSshServerChat,
    createStandaloneSession,
    dashboardData,
    deleteServer,
    deleteWorkspace,
    editingAgentId,
    handleAgentSaved,
    importExistingChat,
    privateItemsPreference.showPrivateItems,
    navigateWithinShell,
    provisioning,
    purgeTask,
    refreshChats,
    refreshSshServers,
    refreshSshSessions,
    refreshTasks,
    refreshWorkspaces,
    schedulerTimezone,
    selectedChat,
    selectedServer,
    selectedTask,
    selectedWorkspace,
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

  const routes = useMemo(() => Object.fromEntries(
    ROUTE_VIEWS.map((view) => [view, renderRouteContent]),
  ) as WebAppRootProps["routes"], [renderRouteContent]);

  const settingsSections = useMemo<NonNullable<NonNullable<WebAppRootProps["settings"]>["sections"]>>(() => [
    {
      id: "quick-chat",
      title: "Quick Chat",
      description: "Configure the default workspace and model used by the Quick Chat shortcut.",
      render: () => (
        <QuickChatSettingsSection
          workspaces={workspaces}
          workspacesLoading={workspacesLoading}
          settings={quickChatSettings.settings}
          loading={quickChatSettings.loading}
          saving={quickChatSettings.saving}
          error={quickChatSettings.error}
          onUpdate={quickChatSettings.updateSettings}
        />
      ),
    },
    {
      id: "agents",
      title: "Agents",
      description: "Configure Clanky-specific agent defaults.",
      render: () => (
        <SchedulerSettingsSection
          timezone={schedulerTimezone.timezone}
          loading={schedulerTimezone.loading}
          saving={schedulerTimezone.saving}
          error={schedulerTimezone.error}
          onUpdate={schedulerTimezone.updateTimezone}
        />
      ),
    },
    {
      id: "private-items",
      title: "Private items",
      description: "Control whether this browser shows or obscures items marked private.",
      render: () => <PrivateItemsSection preference={privateItemsPreference} />,
    },
    {
      id: "content",
      title: "Content",
      description: "Configure Clanky-specific content rendering and file explorer behavior.",
      render: () => (
        <ContentPreferencesSection
          markdown={markdownPreference}
          fullTree={fullTreePreference}
        />
      ),
    },
    {
      id: "clanky-danger-zone",
      title: "Maintenance",
      description: "Clanky-specific maintenance operations. Framework server operations live in the standard settings sections.",
      render: () => (
        <DangerZoneSection
          onPurgeTerminalTasks={async () => {
            const result = await dashboardData.purgeTerminalTasks();
            if (result) {
              await refreshTasks();
            }
            return result;
          }}
          purgingTerminalTasks={dashboardData.appSettingsPurgingTerminalTasks}
        />
      ),
    },
  ], [
    dashboardData,
    fullTreePreference,
    markdownPreference,
    privateItemsPreference,
    quickChatSettings,
    refreshTasks,
    schedulerTimezone,
    workspaces,
    workspacesLoading,
    workspacesSaving,
  ]);

  const sidebarNodes = useCallback(({ search }: { search: string }): SidebarNode[] => {
    const standaloneServerIdBySessionId = new Map<string, string>();
    for (const serverNode of serverNodes) {
      for (const sessionNode of serverNode.sessions) {
        standaloneServerIdBySessionId.set(sessionNode.id, serverNode.server.config.id);
      }
    }

    const activeWork = buildActiveWorkSidebarItems(sidebarWorkspaceGroups, { serverNodes }).map((item): SidebarNode => {
      if (item.kind === "task") {
        const privateHidden = getPrivateHidden(item.taskNode.task.config, [item.workspace]);
        const actions = getTaskSidebarActions(item.taskNode.task);
        return privateSidebarPresentation({
          type: "item",
          id: item.key,
          title: item.taskNode.title,
          subtitle: item.workspaceName,
          badge: item.taskNode.badge,
          badgeVariant: item.taskNode.badgeVariant,
          route: { view: "task", taskId: item.taskNode.task.config.id },
          actions: privateActions(actions, privateHidden, item.taskNode.task.config.isPrivate === true),
          pinnable: true,
          pinId: item.key,
        }, privateHidden);
      }
      if (item.kind === "chat" || item.kind === "ssh-server-chat") {
        const ancestors = item.kind === "chat" ? [item.workspace] : [item.server.config];
        const privateHidden = getPrivateHidden(item.chatNode.chat.config, ancestors);
        const actions = getChatSidebarActions(item.chatNode.chat);
        return privateSidebarPresentation({
          type: "item",
          id: item.key,
          title: item.chatNode.title,
          subtitle: item.kind === "chat" ? item.workspaceName : item.serverName,
          badge: item.chatNode.badge,
          badgeVariant: item.chatNode.badgeVariant,
          route: { view: "chat", chatId: item.chatNode.chat.config.id },
          actions: privateActions(actions, privateHidden, item.chatNode.chat.config.isPrivate === true),
          pinnable: true,
          pinId: item.key,
        }, privateHidden);
      }
      const sessionId = item.kind === "ssh-session" ? item.sessionNode.session.config.id : item.sessionNode.id;
      const session = item.sessionNode.session;
      const ancestors = item.kind === "ssh-session" ? [item.workspace] : [item.server.config];
      const privateHidden = getPrivateHidden(session.config, ancestors);
      const sessionActions = item.kind === "ssh-session"
        ? getSshSessionSidebarActions({ kind: "workspace", id: sessionId, name: item.sessionNode.session.config.name }, session)
        : getSshSessionSidebarActions({
          kind: "standalone",
          id: sessionId,
          name: item.sessionNode.title,
          serverId: standaloneServerIdBySessionId.get(sessionId) ?? "",
        }, session);
      return privateSidebarPresentation({
        type: "item",
        id: item.key,
        title: item.sessionNode.title,
        subtitle: item.kind === "ssh-session" ? item.workspaceName : item.serverName,
        badge: item.sessionNode.badge,
        badgeVariant: item.sessionNode.badgeVariant,
        route: { view: "ssh", sshSessionId: sessionId },
        actions: privateActions(sessionActions, privateHidden, session.config.isPrivate === true),
        pinnable: true,
        pinId: item.key,
      }, privateHidden);
    });

    const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const agentNodesByWorkspace = new Map<string, SidebarNode[]>();
    for (const agent of agents.agents) {
      const workspaceAgents = agentNodesByWorkspace.get(agent.config.workspaceId) ?? [];
      const workspace = workspaceById.get(agent.config.workspaceId) ?? null;
      const privateHidden = getPrivateHidden(agent.config, [workspace]);
      const actions = getAgentSidebarActions(agent);
      workspaceAgents.push(privateSidebarPresentation({
        type: "item",
        id: `agent:${agent.config.id}`,
        title: agent.config.name,
        subtitle: agent.config.enabled ? "Agent" : "Paused agent",
        badge: agent.config.enabled ? "enabled" : "paused",
        badgeVariant: agent.config.enabled ? "success" : "disabled",
        route: { view: "agent", agentId: agent.config.id },
        actions: privateActions(actions, privateHidden, agent.config.isPrivate === true),
        pinnable: true,
        pinId: `agent:${agent.config.id}`,
      }, privateHidden));
      agentNodesByWorkspace.set(agent.config.workspaceId, workspaceAgents);
    }

    const buildWorkspaceNode = (workspaceNode: (typeof sidebarWorkspaceGroups)[number]["workspaces"][number]): SearchableSidebarNode => {
      const workspaceId = workspaceNode.workspace.id;
      const workspacePrivateHidden = getPrivateHidden(workspaceNode.workspace);
      const children: SidebarNode[] = [
        {
          type: "section" as const,
          id: `workspace:${workspaceId}:tasks`,
          title: "Tasks",
          action: {
            id: "new-task",
            title: "New task",
            label: "New",
            route: workspacePrivateHidden ? undefined : { view: "compose", kind: "task", scopeId: workspaceId },
          },
          children: [
            ...workspaceNode.tasks.map((taskNode): SidebarNode => {
              const privateHidden = getPrivateHidden(taskNode.task.config, [workspaceNode.workspace]);
              const actions = getTaskSidebarActions(taskNode.task);
              return privateSidebarPresentation({
                type: "item",
                id: `task:${taskNode.task.config.id}`,
                title: taskNode.title,
                badge: taskNode.badge,
                badgeVariant: taskNode.badgeVariant,
                route: { view: "task", taskId: taskNode.task.config.id },
                actions: privateActions(actions, privateHidden, taskNode.task.config.isPrivate === true),
                pinnable: true,
                pinId: `task:${taskNode.task.config.id}`,
              }, privateHidden);
            }),
            ...(workspaceNode.historyTasks.length > 0 ? [{
              type: "section" as const,
              id: `workspace:${workspaceId}:history`,
              title: "History",
              defaultCollapsed: true,
              children: workspaceNode.historyTasks.map((taskNode): SidebarNode => {
                const privateHidden = getPrivateHidden(taskNode.task.config, [workspaceNode.workspace]);
                const actions = getTaskSidebarActions(taskNode.task);
                return privateSidebarPresentation({
                  type: "item",
                  id: `task:${taskNode.task.config.id}`,
                  title: taskNode.title,
                  badge: taskNode.badge,
                  badgeVariant: taskNode.badgeVariant,
                  route: { view: "task", taskId: taskNode.task.config.id },
                  actions: privateActions(actions, privateHidden, taskNode.task.config.isPrivate === true),
                  pinnable: true,
                  pinId: `task:${taskNode.task.config.id}`,
                }, privateHidden);
              }),
            }] : []),
          ],
        },
        {
          type: "section" as const,
          id: `workspace:${workspaceId}:chats`,
          title: "Chats",
          action: {
            id: "new-chat",
            title: "New chat",
            label: "New",
            route: workspacePrivateHidden ? undefined : { view: "compose", kind: "chat", scopeId: workspaceId },
          },
          children: workspaceNode.chats.map((chatNode): SidebarNode => {
            const privateHidden = getPrivateHidden(chatNode.chat.config, [workspaceNode.workspace]);
            const actions = getChatSidebarActions(chatNode.chat);
            return privateSidebarPresentation({
              type: "item",
              id: `chat:${chatNode.chat.config.id}`,
              title: chatNode.title,
              badge: chatNode.badge,
              badgeVariant: chatNode.badgeVariant,
              route: { view: "chat", chatId: chatNode.chat.config.id },
              actions: privateActions(actions, privateHidden, chatNode.chat.config.isPrivate === true),
              pinnable: true,
              pinId: `chat:${chatNode.chat.config.id}`,
            }, privateHidden);
          }),
        },
        {
          type: "section" as const,
          id: `workspace:${workspaceId}:agents`,
          title: "Agents",
          action: {
            id: "new-agent",
            title: "New agent",
            label: "New",
            route: workspacePrivateHidden ? undefined : { view: "compose", kind: "agent", workspaceId },
          },
          children: agentNodesByWorkspace.get(workspaceId) ?? [],
        },
        {
          type: "section" as const,
          id: `workspace:${workspaceId}:ssh-sessions`,
          title: "SSH sessions",
          action: {
            id: "new-ssh-session",
            title: "New SSH session",
            label: "New",
            route: workspacePrivateHidden ? undefined : { view: "compose", kind: "ssh-session", workspaceId },
          },
          children: workspaceNode.sshSessions.map((sessionNode): SidebarNode => {
            const privateHidden = getPrivateHidden(sessionNode.session.config, [workspaceNode.workspace]);
            const actions = getSshSessionSidebarActions({
              kind: "workspace",
              id: sessionNode.session.config.id,
              name: sessionNode.session.config.name,
            }, sessionNode.session);
            return privateSidebarPresentation({
              type: "item",
              id: `ssh-session:${sessionNode.session.config.id}`,
              title: sessionNode.title,
              subtitle: sessionNode.subtitle,
              badge: sessionNode.badge,
              badgeVariant: sessionNode.badgeVariant,
              route: { view: "ssh", sshSessionId: sessionNode.session.config.id },
              actions: privateActions(actions, privateHidden, sessionNode.session.config.isPrivate === true),
              pinnable: true,
              pinId: `ssh-session:${sessionNode.session.config.id}`,
            }, privateHidden);
          }),
        },
      ];

      return privateSidebarPresentation({
        type: "item",
        id: `workspace:${workspaceId}`,
        title: workspaceNode.workspace.name,
        searchText: workspaceNode.workspace.directory,
        route: { view: "workspace", workspaceId },
        actions: privateActions(
          getWorkspaceSidebarActions(workspaceNode),
          workspacePrivateHidden,
          workspaceNode.workspace.isPrivate === true,
        ),
        pinnable: true,
        pinId: `workspace:${workspaceId}`,
        children,
      }, workspacePrivateHidden);
    };

    const workspaceNodes = sidebarWorkspaceGroups.flatMap((group) => group.workspaces
      .filter((workspaceNode) => workspaceNode.workspace.archived !== true)
      .map(buildWorkspaceNode));
    const archivedWorkspaceNodes = sidebarWorkspaceGroups.flatMap((group) => group.workspaces
      .filter((workspaceNode) => workspaceNode.workspace.archived === true)
      .map(buildWorkspaceNode));

    const sshServerNodes = serverNodes.map((serverNode): SidebarNode => {
      const serverId = serverNode.server.config.id;
      const serverPrivateHidden = getPrivateHidden(serverNode.server.config);
      return privateSidebarPresentation({
        type: "item",
        id: `ssh-server:${serverId}`,
        title: serverNode.server.config.name,
        subtitle: serverNode.server.config.address,
        route: { view: "ssh-server", serverId },
        actions: privateActions(
          getSshServerSidebarActions(serverNode.server),
          serverPrivateHidden,
          serverNode.server.config.isPrivate === true,
        ),
        pinnable: true,
        pinId: `ssh-server:${serverId}`,
        children: [
          {
            type: "section" as const,
            id: `ssh-server:${serverId}:sessions`,
            title: "Sessions",
            action: {
              id: "new-session",
              title: "New SSH session",
              label: "New",
              route: serverPrivateHidden ? undefined : { view: "compose", kind: "ssh-session", serverId },
            },
            children: serverNode.sessions.map((sessionNode): SidebarNode => {
              const privateHidden = getPrivateHidden(sessionNode.session.config, [serverNode.server.config]);
              const actions = getSshSessionSidebarActions({
                kind: "standalone",
                id: sessionNode.id,
                name: sessionNode.title,
                serverId,
              }, sessionNode.session);
              return privateSidebarPresentation({
                type: "item",
                id: `ssh-server-session:${sessionNode.id}`,
                title: sessionNode.title,
                subtitle: sessionNode.subtitle,
                badge: sessionNode.badge,
                badgeVariant: sessionNode.badgeVariant,
                route: { view: "ssh", sshSessionId: sessionNode.id },
                actions: privateActions(actions, privateHidden, sessionNode.session.config.isPrivate === true),
                pinnable: true,
                pinId: `ssh-server-session:${sessionNode.id}`,
              }, privateHidden);
            }),
          },
          {
            type: "section" as const,
            id: `ssh-server:${serverId}:chats`,
            title: "Chats",
            action: {
              id: "new-chat",
              title: "New chat",
              label: "New",
              route: serverPrivateHidden ? undefined : { view: "compose", kind: "ssh-server-chat", scopeId: serverId },
            },
            children: serverNode.chats.map((chatNode): SidebarNode => {
              const privateHidden = getPrivateHidden(chatNode.chat.config, [serverNode.server.config]);
              const actions = getChatSidebarActions(chatNode.chat);
              return privateSidebarPresentation({
                type: "item",
                id: `ssh-server-chat:${chatNode.chat.config.id}`,
                title: chatNode.title,
                badge: chatNode.badge,
                badgeVariant: chatNode.badgeVariant,
                route: { view: "chat", chatId: chatNode.chat.config.id },
                actions: privateActions(actions, privateHidden, chatNode.chat.config.isPrivate === true),
                pinnable: true,
                pinId: `ssh-server-chat:${chatNode.chat.config.id}`,
              }, privateHidden);
            }),
          },
        ],
      }, serverPrivateHidden);
    });

    return filterSidebarNodes([
      ...(activeWork.length > 0 ? [{ type: "section" as const, id: "active-work", title: "Active work", children: activeWork }] : []),
      {
        type: "section",
        id: "workspaces",
        title: "Workspaces",
        action: {
          id: "new-workspace",
          title: "New workspace",
          label: "New",
          route: { view: "compose", kind: "workspace" },
        },
        children: workspaceNodes,
      },
      ...(archivedWorkspaceNodes.length > 0 ? [{
        type: "section" as const,
        id: "archived-workspaces",
        title: "Archived",
        children: archivedWorkspaceNodes,
      }] : []),
      {
        type: "section",
        id: "ssh-servers",
        title: "SSH servers",
        action: {
          id: "new-ssh-server",
          title: "New SSH server",
          label: "New",
          route: { view: "compose", kind: "ssh-server" },
        },
        children: sshServerNodes,
      },
    ], search);
  }, [
    agents.agents,
    getChatSidebarActions,
    getAgentSidebarActions,
    getPrivateHidden,
    getSshSessionSidebarActions,
    getSshServerSidebarActions,
    getTaskSidebarActions,
    getWorkspaceSidebarActions,
    serverNodes,
    sidebarWorkspaceGroups,
    workspaces,
  ]);

  const headerNodes = useMemo(
    () => flattenSidebarNodes(sidebarNodes({ search: "" })),
    [sidebarNodes],
  );
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
        return selectedTask?.state.status === "draft" && nodeModel
          ? { ...nodeModel, title: `Edit ${nodeModel.title}` }
          : nodeModel ?? { title: "Task" };
      case "task-files":
        return nodeModel
          ? { title: nodeModel.title, subtitle: `Files${nodeModel.subtitle ? ` · ${nodeModel.subtitle}` : ""}` }
          : { title: "Task files" };
      case "chat":
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
        const agent = agentId ? agents.agents.find((item) => item.config.id === agentId) : null;
        return editingAgentId && editingAgentId === agentId
          ? { title: `Edit agent ${agent?.config.name ?? nodeModel?.title ?? ""}`.trim() }
          : nodeModel ?? { title: "Agent" };
      }
      case "agent-run": {
        const agentId = getRouteString(route, "agentId");
        const runId = getRouteString(route, "runId");
        const agent = agentId ? agents.agents.find((item) => item.config.id === agentId) : null;
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
    agents.runsByAgentId,
    composeKind,
    composeServer,
    composeWorkspace,
    editingAgentId,
    headerNode,
    route,
    selectedTask,
    selectedWorkspace,
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
        sidebar={{
          search: true,
          pinning: { sectionTitle: "Pinned", storageKey: "clanky.frameworkSidebarPins" },
          topActions: [
            {
              id: "quick-chat",
              title: quickChatUnavailableReason ?? "Start Quick Chat",
              label: quickChatCreating ? "Creating..." : "Start Quick Chat",
              icon: "chat",
              onAction: () => void handleQuickChat(),
            },
            {
              id: "code-explorer",
              title: "Code Explorer",
              label: "Code Explorer",
              icon: "code",
              route: { view: "code-explorer" },
            },
          ],
          getNodes: sidebarNodes,
        }}
        routes={routes}
        onRouteChange={handleWebRouteChange}
        header={{
          renderTitle: () => <RouteHeaderTitle model={headerModel} />,
          getActions: () => headerActions,
        }}
        settings={{ sections: settingsSections }}
        version={dashboardData.version ?? undefined}
      />

      <RenameSshSessionModal
        isOpen={Boolean(renameSshSessionTarget)}
        onClose={() => setRenameSshSessionTarget(null)}
        currentName={renameSshSessionTarget?.name ?? ""}
        onRename={renameSshSession}
      />
      <ConfirmModal
        isOpen={Boolean(deleteSshSessionTarget)}
        onClose={() => setDeleteSshSessionTarget(null)}
        onConfirm={() => void deleteSshSession()}
        title="Delete SSH session?"
        message={deleteSshSessionTarget
          ? `This removes "${deleteSshSessionTarget.name}" from Clanky and attempts to stop any persistent remote session.`
          : ""}
        confirmLabel="Delete"
        loading={false}
      />
      <ConfirmModal
        isOpen={Boolean(deleteAgentTarget)}
        onClose={() => setDeleteAgentTarget(null)}
        onConfirm={() => void deleteAgent()}
        title="Delete agent"
        message={deleteAgentTarget ? `Delete "${deleteAgentTarget.config.name}" and its runs?` : ""}
        confirmLabel="Delete agent"
        loading={deleteAgentPending}
      />
      <ConfirmModal
        isOpen={Boolean(purgeAgentTarget)}
        onClose={() => setPurgeAgentTarget(null)}
        onConfirm={() => void purgeAgentRuns()}
        title="Purge agent runs"
        message={purgeAgentTarget ? `Purge all completed, failed, skipped, interrupted, and cancelled runs for "${purgeAgentTarget.config.name}"? This cannot be undone.` : ""}
        confirmLabel="Purge runs"
        loading={purgeAgentPending}
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
      {chatActions.modals}
    </>
  );
}

export default AppShell;
