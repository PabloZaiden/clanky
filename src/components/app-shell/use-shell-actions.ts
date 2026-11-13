import { useCallback, useMemo, useRef, useState } from "react";
import type { ToastService, WebAppRoute } from "@pablozaiden/webapp/web";
import type {
  Automation,
  Chat,
  Workspace,
  TerminalSession,
} from "@/shared";
import type { CreateExecutionHostChatRequest } from "@/contracts";
import { isWorkspaceChat } from "@/shared/chat";
import { isAgentProvider } from "@/shared/settings";
import {
  type UseAutomationsResult,
  type UseChatsResult,
  type UseDashboardDataResult,
  type UseGithubUsernameResult,
  type UseMeshResult,
  type UseProvisioningJobResult,
  type UseQuickChatSettingsResult,
  type UseTerminalSessionsResult,
  type UseWorkspacesResult,
} from "../../hooks";
import { useWorkspaceCreate } from "./use-workspace-create";
import { useWorkspaceSettingsShell } from "./use-workspace-settings-shell";
import { useChatActions } from "./chat-actions";
import { useShellDialogComposition } from "./shell-dialog-composition";

interface UseShellActionsOptions {
  route: WebAppRoute;
  navigateWithinShell: (route: WebAppRoute) => void;
  provisioning: UseProvisioningJobResult;
  mesh: UseMeshResult;
  createWorkspace: UseWorkspacesResult["createWorkspace"];
  refreshWorkspaces: UseWorkspacesResult["refresh"];
  pullLatestChanges: UseWorkspacesResult["pullLatestChanges"];
  dashboardData: UseDashboardDataResult;
  toast: ToastService;
  markChatDone: UseChatsResult["markChatDone"];
  deleteChat: UseChatsResult["deleteChat"];
  selectedChat: Chat | null;
  refreshChats: UseChatsResult["refresh"];
  updateChat: UseChatsResult["updateChat"];
  automations: UseAutomationsResult;
  updateTerminalSession: UseTerminalSessionsResult["updateSession"];
  deleteTerminalSession: UseTerminalSessionsResult["deleteSession"];
  createChat: UseChatsResult["createChat"];
  createChatHere: UseChatsResult["createChatHere"];
  createExecutionHostChat: UseChatsResult["createExecutionHostChat"];
  quickChatSettings: UseQuickChatSettingsResult;
  githubUsername: UseGithubUsernameResult;
  quickChatWorkspace: Workspace | null;
}

export function useShellActions({
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
}: UseShellActionsOptions) {
  const routeRef = useRef(route);
  routeRef.current = route;
  const pullingLatestWorkspaceIdsRef = useRef<Set<string>>(new Set());
  const [pullingLatestWorkspaceIds, setPullingLatestWorkspaceIds] = useState<ReadonlySet<string>>(() => new Set());
  const { refreshBranchDataIfCurrent } = dashboardData;

  const workspaceCreate = useWorkspaceCreate({
    route,
    provisioning,
    createWorkspace,
    refreshWorkspaces,
    toast,
    navigateWithinShell,
    githubUsername,
    relayStatus: mesh.relayStatus,
    relayStatusLoading: mesh.relayStatusLoading,
    refreshRelayStatus: mesh.refreshRelayStatus,
  });

  const workspaceSettings = useWorkspaceSettingsShell({
    route,
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

      await refreshBranchDataIfCurrent(workspaceId);

      const branchLabel = result.defaultBranch ?? result.currentBranch ?? "the default branch";
      toast.success(`Pulled latest changes for "${branchLabel}".`);
    } catch (error) {
      toast.error(String(error));
    } finally {
      pullingLatestWorkspaceIdsRef.current.delete(workspaceId);
      setPullingLatestWorkspaceIds(new Set(pullingLatestWorkspaceIdsRef.current));
    }
  }, [pullLatestChanges, refreshBranchDataIfCurrent, toast]);

  const handleMarkChatDone = useCallback(async (chat: Chat): Promise<Chat | null> => {
    const updated = await markChatDone(chat.config.id);
    if (updated) {
      toast.success("Chat marked as done.");
    }
    return updated;
  }, [markChatDone, toast]);
  const createChatInCurrentDirectory = useCallback(async (
    sourceChat: Chat,
    directory: string,
  ): Promise<void> => {
    let createdChat: Chat;
    if (isWorkspaceChat(sourceChat)) {
      createdChat = await createChatHere(sourceChat.config.id);
    } else {
      const source = sourceChat.config.source;
      if (source?.kind !== "execution_host") {
        throw new Error("The current chat's execution host is unavailable.");
      }

      const executionHost = source.executionHost.host;
      const providerID = sourceChat.config.model.providerID;
      if (!isAgentProvider(providerID)) {
        throw new Error("The current model provider cannot be reused on this execution host.");
      }

      const request: CreateExecutionHostChatRequest = {
        directory,
        model: {
          providerID,
          modelID: sourceChat.config.model.modelID,
          variant: sourceChat.config.model.variant,
        },
      };
      createdChat = await createExecutionHostChat(executionHost, request);
    }

    navigateWithinShell({ view: "chat", chatId: createdChat.config.id });
  }, [
    createChatHere,
    createExecutionHostChat,
    navigateWithinShell,
  ]);
  const chatActions = useChatActions({
    chat: route.view === "chat" ? selectedChat : null,
    hasCodeExplorerAction: true,
    onOpenCodeExplorer: (chat) => navigateWithinShell({
      view: "code-explorer",
      contentType: "chat",
      chatId: chat.config.id,
    }),
    onCreateChatInCurrentDirectory: createChatInCurrentDirectory,
    onChatRenamed: () => refreshChats(),
    onChatDone: handleMarkChatDone,
    onDeleteChat: deleteChat,
    onChatDeleted: (target) => {
      if (routeRef.current["chatId"] === target.config.id) navigateWithinShell({ view: "home" });
    },
    onActionError: (message) => toast.error(message),
  });
  const selectedChatActions = useMemo(() => chatActions.items, [chatActions.items]);
  const dialogs = useShellDialogComposition({
    route,
    navigateWithinShell,
    onError: toast.error,
    updateTerminalSession,
    deleteTerminalSession,
    automations,
    createChat,
    quickChatSettings,
    quickChatWorkspace,
    chatActionModals: chatActions.modals,
  });

  const toggleChatPrivate = useCallback(async (chat: Chat): Promise<void> => {
    const updated = await updateChat(chat.config.id, { isPrivate: !chat.config.isPrivate });
    if (!updated) {
      toast.error(chat.config.isPrivate ? "Failed to unmark chat as private" : "Failed to mark chat as private");
    }
  }, [toast, updateChat]);

  const toggleAutomationPrivate = useCallback(async (automation: Automation): Promise<void> => {
    const updated = await automations.updateAutomation(automation.config.id, { isPrivate: !automation.config.isPrivate });
    if (!updated) {
      toast.error(automation.config.isPrivate ? "Failed to unmark automation as private" : "Failed to mark automation as private");
    }
  }, [automations, toast]);

  const toggleTerminalSessionPrivate = useCallback(async (session: TerminalSession): Promise<void> => {
    try {
      await updateTerminalSession(session.config.id, { isPrivate: !session.config.isPrivate });
    } catch (error) {
      toast.error(String(error));
    }
  }, [toast, updateTerminalSession]);

  return {
    workspaceCreate,
    workspaceSettings,
    chatActions,
    selectedChatActions,
    dialogs,
    pullingLatestWorkspaceIds,
    pullLatestWorkspaceChanges,
    getChatLifecycleActions: chatActions.getLifecycleActions,
    toggleChatPrivate,
    toggleAutomationPrivate,
    toggleTerminalSessionPrivate,
  };
}
