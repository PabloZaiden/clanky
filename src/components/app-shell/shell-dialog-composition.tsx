import { useCallback, useState, type ReactNode } from "react";
import {
  ConfirmModal,
  Modal,
  type ToastService,
  type WebAppRoute,
} from "@pablozaiden/webapp/web";
import type { CreateChatRequest } from "@/contracts";
import type { Agent, Workspace } from "@/shared";
import type {
  UseAgentsResult,
  UseChatsResult,
  UseQuickChatSettingsResult,
  UseTerminalSessionsResult,
} from "../../hooks";
import { RenameSessionModal } from "../RenameSessionModal";
import { getRouteString } from "./route-fields";
import type { TerminalSessionActionTarget } from "./shell-sidebar-composition";

interface ShellDialogCompositionOptions {
  route: WebAppRoute;
  navigateWithinShell: (route: WebAppRoute) => void;
  onError: ToastService["error"];
  updateTerminalSession: UseTerminalSessionsResult["updateSession"];
  deleteTerminalSession: UseTerminalSessionsResult["deleteSession"];
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
  openRenameTerminalSession: (target: TerminalSessionActionTarget) => void;
  openDeleteTerminalSession: (target: TerminalSessionActionTarget) => void;
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
  updateTerminalSession,
  deleteTerminalSession,
  agents,
  createChat,
  quickChatSettings,
  quickChatWorkspace,
  chatActionModals,
}: ShellDialogCompositionOptions): ShellDialogComposition {
  const [renameTerminalSessionTarget, setRenameTerminalSessionTarget] = useState<TerminalSessionActionTarget | null>(null);
  const [deleteTerminalSessionTarget, setDeleteTerminalSessionTarget] = useState<TerminalSessionActionTarget | null>(null);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [deleteAgentTarget, setDeleteAgentTarget] = useState<Agent | null>(null);
  const [deleteAgentPending, setDeleteAgentPending] = useState(false);
  const [purgeAgentTarget, setPurgeAgentTarget] = useState<Agent | null>(null);
  const [purgeAgentPending, setPurgeAgentPending] = useState(false);
  const [quickChatCreating, setQuickChatCreating] = useState(false);

  const openRenameTerminalSession = useCallback((target: TerminalSessionActionTarget) => {
    setRenameTerminalSessionTarget(target);
  }, []);

  const openDeleteTerminalSession = useCallback((target: TerminalSessionActionTarget) => {
    setDeleteTerminalSessionTarget(target);
  }, []);

  const renameTerminalSession = useCallback(async (newName: string): Promise<void> => {
    if (!renameTerminalSessionTarget) {
      return;
    }
    await updateTerminalSession(renameTerminalSessionTarget.id, { name: newName });
    setRenameTerminalSessionTarget(null);
  }, [renameTerminalSessionTarget, updateTerminalSession]);

  const deleteTerminalSessionAction = useCallback(async (): Promise<void> => {
    if (!deleteTerminalSessionTarget) {
      return;
    }
    try {
      const success = await deleteTerminalSession(deleteTerminalSessionTarget.id);
      if (!success) {
        onError("Failed to delete terminal session.");
        return;
      }
      const deletedActiveSession = route.view === "terminal"
        && getRouteString(route, "terminalSessionId") === deleteTerminalSessionTarget.id;
      setDeleteTerminalSessionTarget(null);
      if (deletedActiveSession) {
        navigateWithinShell({ view: "home" });
      }
    } catch (error) {
      onError(String(error));
    }
  }, [deleteTerminalSession, deleteTerminalSessionTarget, navigateWithinShell, onError, route]);

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
        useWorktree: quickChatWorkspace.workspaceType === "git" ? settings.useWorktree : false,
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
      <RenameSessionModal
        isOpen={Boolean(renameTerminalSessionTarget)}
        onClose={() => setRenameTerminalSessionTarget(null)}
        currentName={renameTerminalSessionTarget?.name ?? ""}
        onRename={renameTerminalSession}
        sessionKind="terminal"
      />
      <ConfirmModal
        isOpen={Boolean(deleteTerminalSessionTarget)}
        onClose={() => setDeleteTerminalSessionTarget(null)}
        onConfirm={() => void deleteTerminalSessionAction()}
        title="Delete terminal session?"
        message={deleteTerminalSessionTarget
          ? `This removes "${deleteTerminalSessionTarget.name}" from Clanky and attempts to stop any persistent session.`
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
    openRenameTerminalSession,
    openDeleteTerminalSession,
    setDeleteAgentTarget,
    setPurgeAgentTarget,
    quickChatCreating,
    handleQuickChat,
    modals,
  };
}
