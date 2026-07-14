import { useCallback, useState, type ReactNode } from "react";
import {
  ConfirmModal,
  Modal,
  type WebAppRoute,
} from "@pablozaiden/webapp/web";
import type { CreateChatRequest } from "@/contracts";
import type { Agent, Workspace } from "@/shared";
import type {
  UseAgentsResult,
  UseChatsResult,
  UseQuickChatSettingsResult,
  UseSshServersResult,
  UseSshSessionsResult,
  ToastContextValue,
} from "../../hooks";
import { RenameSshSessionModal } from "../RenameSshSessionModal";
import { getRouteString } from "./route-fields";
import type { SshSessionActionTarget } from "./shell-sidebar-composition";

interface ShellDialogCompositionOptions {
  route: WebAppRoute;
  navigateWithinShell: (route: WebAppRoute) => void;
  onError: ToastContextValue["error"];
  updateWorkspaceSshSession: UseSshSessionsResult["updateSession"];
  updateStandaloneSession: UseSshServersResult["updateSession"];
  refreshSshServers: UseSshServersResult["refresh"];
  deleteWorkspaceSshSession: UseSshSessionsResult["deleteSession"];
  deleteStandaloneSession: UseSshServersResult["deleteSession"];
  agents: UseAgentsResult;
  createChat: UseChatsResult["createChat"];
  quickChatSettings: UseQuickChatSettingsResult;
  quickChatWorkspace: Workspace | null;
  chatActionModals: ReactNode;
}

export interface ShellDialogComposition {
  editingAgentId: string | null;
  setEditingAgentId: (agentId: string) => void;
  cancelAgentEdit: () => void;
  handleAgentSaved: (agent: Agent) => void;
  openRenameSshSession: (target: SshSessionActionTarget) => void;
  openDeleteSshSession: (target: SshSessionActionTarget) => void;
  setDeleteAgentTarget: (agent: Agent) => void;
  setPurgeAgentTarget: (agent: Agent) => void;
  quickChatCreating: boolean;
  handleQuickChat: () => Promise<void>;
  modals: ReactNode;
}

export function useShellDialogComposition({
  route,
  navigateWithinShell,
  onError,
  updateWorkspaceSshSession,
  updateStandaloneSession,
  refreshSshServers,
  deleteWorkspaceSshSession,
  deleteStandaloneSession,
  agents,
  createChat,
  quickChatSettings,
  quickChatWorkspace,
  chatActionModals,
}: ShellDialogCompositionOptions): ShellDialogComposition {
  const [renameSshSessionTarget, setRenameSshSessionTarget] = useState<SshSessionActionTarget | null>(null);
  const [deleteSshSessionTarget, setDeleteSshSessionTarget] = useState<SshSessionActionTarget | null>(null);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [deleteAgentTarget, setDeleteAgentTarget] = useState<Agent | null>(null);
  const [deleteAgentPending, setDeleteAgentPending] = useState(false);
  const [purgeAgentTarget, setPurgeAgentTarget] = useState<Agent | null>(null);
  const [purgeAgentPending, setPurgeAgentPending] = useState(false);
  const [quickChatCreating, setQuickChatCreating] = useState(false);

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
  }, [
    refreshSshServers,
    renameSshSessionTarget,
    updateStandaloneSession,
    updateWorkspaceSshSession,
  ]);

  const deleteSshSession = useCallback(async (): Promise<void> => {
    if (!deleteSshSessionTarget) {
      return;
    }
    try {
      const success = deleteSshSessionTarget.kind === "workspace"
        ? await deleteWorkspaceSshSession(deleteSshSessionTarget.id)
        : await deleteStandaloneSession(deleteSshSessionTarget.serverId, deleteSshSessionTarget.id);
      if (!success) {
        onError("Failed to delete SSH session.");
        return;
      }
      const deletedActiveSession = route.view === "ssh"
        && getRouteString(route, "sshSessionId") === deleteSshSessionTarget.id;
      setDeleteSshSessionTarget(null);
      if (deletedActiveSession) {
        navigateWithinShell({ view: "home" });
      }
    } catch (error) {
      onError(String(error));
    }
  }, [
    deleteSshSessionTarget,
    deleteStandaloneSession,
    deleteWorkspaceSshSession,
    navigateWithinShell,
    onError,
    route,
  ]);

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
        onError("Failed to delete agent");
        return;
      }
      const deletedActiveAgent = route.view === "agent"
        && getRouteString(route, "agentId") === deleteAgentTarget.config.id;
      setDeleteAgentTarget(null);
      if (deletedActiveAgent) {
        navigateWithinShell({ view: "agents", workspaceId: deleteAgentTarget.config.workspaceId });
      }
    } catch (error) {
      onError(String(error));
    } finally {
      setDeleteAgentPending(false);
    }
  }, [agents, deleteAgentTarget, navigateWithinShell, onError, route]);

  const purgeAgentRuns = useCallback(async (): Promise<void> => {
    if (!purgeAgentTarget) {
      return;
    }
    setPurgeAgentPending(true);
    try {
      await agents.purgeRuns(purgeAgentTarget.config.id);
      setPurgeAgentTarget(null);
    } catch (error) {
      onError(String(error));
    } finally {
      setPurgeAgentPending(false);
    }
  }, [agents, onError, purgeAgentTarget]);

  const handleQuickChat = useCallback(async (): Promise<void> => {
    if (quickChatSettings.loading || quickChatCreating) {
      return;
    }

    const settings = quickChatSettings.settings;
    if (!settings.workspaceId) {
      onError("Choose a quick chat workspace in Settings first");
      return;
    }
    if (!quickChatWorkspace) {
      onError("The selected quick chat workspace no longer exists");
      return;
    }
    if (!settings.model) {
      onError("Choose a quick chat model in Settings first");
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
      } satisfies CreateChatRequest);
      if (!chat) {
        onError("Failed to create quick chat");
        return;
      }
      navigateWithinShell({ view: "chat", chatId: chat.config.id });
    } catch (error) {
      onError(String(error));
    } finally {
      setQuickChatCreating(false);
    }
  }, [
    createChat,
    navigateWithinShell,
    onError,
    quickChatCreating,
    quickChatSettings,
    quickChatWorkspace,
  ]);

  const modals = (
    <>
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
      {chatActionModals}
    </>
  );

  return {
    editingAgentId,
    setEditingAgentId,
    cancelAgentEdit,
    handleAgentSaved,
    openRenameSshSession,
    openDeleteSshSession,
    setDeleteAgentTarget,
    setPurgeAgentTarget,
    quickChatCreating,
    handleQuickChat,
    modals,
  };
}
