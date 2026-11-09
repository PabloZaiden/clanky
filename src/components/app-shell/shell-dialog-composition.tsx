import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  ConfirmModal,
  Modal,
  type ToastService,
  type WebAppRoute,
} from "@pablozaiden/webapp/web";
import type { CreateChatRequest } from "@/contracts";
import type { Automation, Workspace } from "@/shared";
import type {
  UseAutomationsResult,
  UseChatsResult,
  UseQuickChatSettingsResult,
  UseTerminalSessionsResult,
} from "../../hooks";
import { RenameSessionModal } from "../RenameSessionModal";
import { getRouteString } from "./route-fields";
import type { TerminalSessionActionTarget } from "./shell-sidebar-types";

interface ShellDialogCompositionOptions {
  route: WebAppRoute;
  navigateWithinShell: (route: WebAppRoute) => void;
  onError: ToastService["error"];
  updateTerminalSession: UseTerminalSessionsResult["updateSession"];
  deleteTerminalSession: UseTerminalSessionsResult["deleteSession"];
  automations: UseAutomationsResult;
  createChat: UseChatsResult["createChat"];
  quickChatSettings: UseQuickChatSettingsResult;
  quickChatWorkspace: Workspace | null;
  chatActionModals: ReactNode;
}

export interface ShellDialogComposition {
  editingAutomationId: string | null;
  setEditingAutomationId: (automationId: string) => void;
  cancelAutomationEdit: () => void;
  handleAutomationSaved: (automation: Automation) => void;
  openRenameTerminalSession: (target: TerminalSessionActionTarget) => void;
  openDeleteTerminalSession: (target: TerminalSessionActionTarget) => void;
  setDeleteAutomationTarget: (automation: Automation) => void;
  setPurgeAutomationTarget: (automation: Automation) => void;
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
  automations,
  createChat,
  quickChatSettings,
  quickChatWorkspace,
  chatActionModals,
}: ShellDialogCompositionOptions): ShellDialogComposition {
  const [renameTerminalSessionTarget, setRenameTerminalSessionTarget] = useState<TerminalSessionActionTarget | null>(null);
  const [deleteTerminalSessionTarget, setDeleteTerminalSessionTarget] = useState<TerminalSessionActionTarget | null>(null);
  const [deleteTerminalSessionPending, setDeleteTerminalSessionPending] = useState(false);
  const deleteTerminalSessionPendingRef = useRef(false);
  const [editingAutomationId, setEditingAutomationId] = useState<string | null>(null);
  const [deleteAutomationTarget, setDeleteAutomationTarget] = useState<Automation | null>(null);
  const [deleteAutomationPending, setDeleteAutomationPending] = useState(false);
  const [purgeAutomationTarget, setPurgeAutomationTarget] = useState<Automation | null>(null);
  const [purgeAutomationPending, setPurgeAutomationPending] = useState(false);
  const [quickChatCreating, setQuickChatCreating] = useState(false);

  const openRenameTerminalSession = useCallback((target: TerminalSessionActionTarget) => {
    setRenameTerminalSessionTarget(target);
  }, []);

  const openDeleteTerminalSession = useCallback((target: TerminalSessionActionTarget) => {
    setDeleteTerminalSessionTarget(target);
  }, []);

  const closeDeleteTerminalSession = useCallback(() => {
    if (deleteTerminalSessionPendingRef.current) {
      return;
    }
    setDeleteTerminalSessionTarget(null);
  }, []);

  const renameTerminalSession = useCallback(async (newName: string): Promise<void> => {
    if (!renameTerminalSessionTarget) {
      return;
    }
    await updateTerminalSession(renameTerminalSessionTarget.id, { name: newName });
    setRenameTerminalSessionTarget(null);
  }, [renameTerminalSessionTarget, updateTerminalSession]);

  const deleteTerminalSessionAction = useCallback(async (): Promise<void> => {
    const target = deleteTerminalSessionTarget;
    if (!target || deleteTerminalSessionPendingRef.current) {
      return;
    }
    deleteTerminalSessionPendingRef.current = true;
    setDeleteTerminalSessionPending(true);
    try {
      const success = await deleteTerminalSession(target.id);
      if (!success) {
        onError("Failed to delete terminal session.");
        return;
      }
      const deletedActiveSession = route.view === "terminal"
        && getRouteString(route, "terminalSessionId") === target.id;
      setDeleteTerminalSessionTarget((currentTarget) => (
        currentTarget?.id === target.id ? null : currentTarget
      ));
      if (deletedActiveSession) {
        navigateWithinShell({ view: "home" });
      }
    } catch (error) {
      onError(String(error));
    } finally {
      deleteTerminalSessionPendingRef.current = false;
      setDeleteTerminalSessionPending(false);
    }
  }, [deleteTerminalSession, deleteTerminalSessionTarget, navigateWithinShell, onError, route]);

  const cancelAutomationEdit = useCallback(() => {
    setEditingAutomationId(null);
  }, []);

  const handleAutomationSaved = useCallback((savedAutomation: Automation) => {
    setEditingAutomationId(null);
    navigateWithinShell({ view: "automation", automationId: savedAutomation.config.id });
  }, [navigateWithinShell]);

  const deleteAutomation = useCallback(async (): Promise<void> => {
    if (!deleteAutomationTarget) {
      return;
    }
    setDeleteAutomationPending(true);
    try {
      const deleted = await automations.deleteAutomation(deleteAutomationTarget.config.id);
      if (!deleted) {
        onError("Failed to delete automation");
        return;
      }
      const deletedActiveAutomation = route.view === "automation"
        && getRouteString(route, "automationId") === deleteAutomationTarget.config.id;
      setDeleteAutomationTarget(null);
      if (deletedActiveAutomation) {
        navigateWithinShell({ view: "automations", workspaceId: deleteAutomationTarget.config.workspaceId });
      }
    } catch (error) {
      onError(String(error));
    } finally {
      setDeleteAutomationPending(false);
    }
  }, [automations, deleteAutomationTarget, navigateWithinShell, onError, route]);

  const purgeAutomationRuns = useCallback(async (): Promise<void> => {
    if (!purgeAutomationTarget) {
      return;
    }
    setPurgeAutomationPending(true);
    try {
      await automations.purgeRuns(purgeAutomationTarget.config.id);
      setPurgeAutomationTarget(null);
    } catch (error) {
      onError(String(error));
    } finally {
      setPurgeAutomationPending(false);
    }
  }, [automations, onError, purgeAutomationTarget]);

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
        useWorktree: quickChatWorkspace.workspaceType === "git"
          && quickChatWorkspace.allowWorktrees !== false
          ? settings.useWorktree
          : false,
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
      />
      <ConfirmModal
        isOpen={Boolean(deleteTerminalSessionTarget)}
        onClose={closeDeleteTerminalSession}
        onConfirm={() => void deleteTerminalSessionAction()}
        title="Delete terminal session?"
        message={deleteTerminalSessionTarget
          ? `This removes "${deleteTerminalSessionTarget.name}" from Clanky and attempts to stop any persistent session.`
          : ""}
        confirmLabel="Delete"
        variant="danger"
        loading={deleteTerminalSessionPending}
      />
      <ConfirmModal
        isOpen={Boolean(deleteAutomationTarget)}
        onClose={() => setDeleteAutomationTarget(null)}
        onConfirm={() => void deleteAutomation()}
        title="Delete automation"
        message={deleteAutomationTarget ? `Delete "${deleteAutomationTarget.config.name}" and its runs?` : ""}
        confirmLabel="Delete automation"
        variant="danger"
        loading={deleteAutomationPending}
      />
      <ConfirmModal
        isOpen={Boolean(purgeAutomationTarget)}
        onClose={() => setPurgeAutomationTarget(null)}
        onConfirm={() => void purgeAutomationRuns()}
        title="Purge automation runs"
        message={purgeAutomationTarget ? `Purge all completed, failed, skipped, interrupted, and cancelled runs for "${purgeAutomationTarget.config.name}"? This cannot be undone.` : ""}
        confirmLabel="Purge runs"
        variant="danger"
        loading={purgeAutomationPending}
      />
      <Modal
        isOpen={quickChatCreating}
        onClose={() => {}}
        title="Creating quick chat"
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
    editingAutomationId,
    setEditingAutomationId,
    cancelAutomationEdit,
    handleAutomationSaved,
    openRenameTerminalSession,
    openDeleteTerminalSession,
    setDeleteAutomationTarget,
    setPurgeAutomationTarget,
    quickChatCreating,
    handleQuickChat,
    modals,
  };
}
