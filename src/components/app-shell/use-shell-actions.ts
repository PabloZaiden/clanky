import { useCallback, useMemo, useRef, useState } from "react";
import type { ToastService, WebAppRoute } from "@pablozaiden/webapp/web";
import type {
  Agent,
  Chat,
  SshServer,
  SshServerSession,
  SshSession,
  Task,
  Workspace,
  WorkspaceTerminalSession,
} from "@/shared";
import { getChatWorkspaceId, isWorkspaceChat } from "@/shared/chat";
import {
  stopTaskApi,
  type UseAgentsResult,
  type UseChatsResult,
  type UseDashboardDataResult,
  type UseProvisioningJobResult,
  type UseQuickChatSettingsResult,
  type UseSshServersResult,
  type UseSshSessionsResult,
  type UseTasksResult,
  type UseTerminalSessionsResult,
  type UseWorkspacesResult,
  type WorkspaceGroup,
} from "../../hooks";
import { useWorkspaceCreate } from "./use-workspace-create";
import { useWorkspaceSettingsShell } from "./use-workspace-settings-shell";
import { useComposeState } from "./use-compose-state";
import { useChatActions } from "./chat-actions";
import { useShellDialogComposition } from "./shell-dialog-composition";

interface UseShellActionsOptions {
  route: WebAppRoute;
  navigateWithinShell: (route: WebAppRoute) => void;
  servers: SshServer[];
  provisioning: UseProvisioningJobResult;
  createWorkspace: UseWorkspacesResult["createWorkspace"];
  refreshWorkspaces: UseWorkspacesResult["refresh"];
  workspaceGroups: WorkspaceGroup[];
  purgeArchivedWorkspaceTasks: UseTasksResult["purgeArchivedWorkspaceTasks"];
  pullLatestChanges: UseWorkspacesResult["pullLatestChanges"];
  updateWorkspace: UseWorkspacesResult["updateWorkspace"];
  createTask: UseTasksResult["createTask"];
  refreshTasks: UseTasksResult["refresh"];
  dashboardData: UseDashboardDataResult;
  toast: ToastService;
  markChatDone: UseChatsResult["markChatDone"];
  deleteChat: UseChatsResult["deleteChat"];
  selectedChat: Chat | null;
  refreshChats: UseChatsResult["refresh"];
  updateChat: UseChatsResult["updateChat"];
  agents: UseAgentsResult;
  updateTask: UseTasksResult["updateTask"];
  updateWorkspaceSshSession: UseSshSessionsResult["updateSession"];
  updateStandaloneSession: UseSshServersResult["updateSession"];
  updateServer: UseSshServersResult["updateServer"];
  refreshSshServers: UseSshServersResult["refresh"];
  deleteWorkspaceSshSession: UseSshSessionsResult["deleteSession"];
  updateTerminalSession: UseTerminalSessionsResult["updateSession"];
  deleteTerminalSession: UseTerminalSessionsResult["deleteSession"];
  deleteStandaloneSession: UseSshServersResult["deleteSession"];
  createChat: UseChatsResult["createChat"];
  quickChatSettings: UseQuickChatSettingsResult;
  quickChatWorkspace: Workspace | null;
}

export function useShellActions({
  route,
  navigateWithinShell,
  servers,
  provisioning,
  createWorkspace,
  refreshWorkspaces,
  workspaceGroups,
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
  updateWorkspaceSshSession,
  updateStandaloneSession,
  updateServer,
  refreshSshServers,
  deleteWorkspaceSshSession,
  updateTerminalSession,
  deleteTerminalSession,
  deleteStandaloneSession,
  createChat,
  quickChatSettings,
  quickChatWorkspace,
}: UseShellActionsOptions) {
  const pullingLatestWorkspaceIdsRef = useRef<Set<string>>(new Set());
  const archivingWorkspaceIdsRef = useRef<Set<string>>(new Set());
  const [pullingLatestWorkspaceIds, setPullingLatestWorkspaceIds] = useState<ReadonlySet<string>>(() => new Set());
  const [archivingWorkspaceIds, setArchivingWorkspaceIds] = useState<ReadonlySet<string>>(() => new Set());

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

  const handleMarkChatDone = useCallback(async (chat: Chat): Promise<Chat | null> => {
    const updated = await markChatDone(chat.config.id);
    if (updated) {
      toast.success("Chat marked as done.");
    }
    return updated;
  }, [markChatDone, toast]);
  const handleSidebarMarkChatDone = useCallback(async (chat: Chat): Promise<void> => {
    await handleMarkChatDone(chat);
  }, [handleMarkChatDone]);
  const canSpawnTasksFromSelectedChat = useMemo(() => {
    if (!selectedChat || !isWorkspaceChat(selectedChat)) {
      return true;
    }

    const workspaceId = getChatWorkspaceId(selectedChat);
    return workspaceGroups.some(({ workspace }) =>
      workspace.id === workspaceId && workspace.workspaceType === "git"
    );
  }, [selectedChat, workspaceGroups]);
  const chatActions = useChatActions({
    chat: route.view === "chat" ? selectedChat : null,
    canSpawnTasks: canSpawnTasksFromSelectedChat,
    hasCodeExplorerAction: true,
    onOpenCodeExplorer: (chat) => navigateWithinShell({
      view: "code-explorer",
      contentType: "chat",
      chatId: chat.config.id,
    }),
    onTaskSpawned: (task) => navigateWithinShell({ view: "task", taskId: task.config.id }),
    onChatRenamed: refreshChats,
    onChatDone: handleMarkChatDone,
    onDeleteChat: deleteChat,
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
    updateTerminalSession,
    deleteTerminalSession,
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

  const toggleTerminalSessionPrivate = useCallback(async (session: WorkspaceTerminalSession): Promise<void> => {
    try {
      await updateTerminalSession(session.config.id, { isPrivate: !session.config.isPrivate });
    } catch (error) {
      toast.error(String(error));
    }
  }, [toast, updateTerminalSession]);

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

  return {
    workspaceCreate,
    workspaceSettings,
    composeState,
    chatActions,
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
    toggleWorkspaceSshSessionPrivate,
    toggleTerminalSessionPrivate,
    toggleSshServerPrivate,
    toggleStandaloneSshSessionPrivate,
    stopSidebarTask,
  };
}
