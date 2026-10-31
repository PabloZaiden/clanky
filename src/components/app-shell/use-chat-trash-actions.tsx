import { useCallback, useMemo, useState } from "react";
import { ConfirmModal, useToast, type ActionMenuItem, type WebAppRoute } from "@pablozaiden/webapp/web";
import type { ChatTrashResult, TrashedChat } from "@/contracts/schemas/chat-trash";
import { apiRequest } from "../../lib/api-client";
import { decodeCollaborationResourceReference } from "@/shared/collaboration-reference";
import type { Workspace } from "@/shared";

export function useChatTrashActions(
  navigate: (route: WebAppRoute) => void,
  refreshChats: () => Promise<void>,
  workspaces: Workspace[],
) {
  const toast = useToast();
  const [target, setTarget] = useState<TrashedChat | "all" | null>(null);
  const [pending, setPending] = useState(false);
  const canModify = useCallback((chat: TrashedChat): boolean => {
    const workspace = workspaces.find((entry) => entry.id === chat.workspaceId);
    return workspace ? workspace.access !== "read" : !decodeCollaborationResourceReference(chat.id);
  }, [workspaces]);

  const restore = useCallback(async (chat: TrashedChat): Promise<void> => {
    if (!canModify(chat)) {
      toast.error("This workspace is read-only.");
      return;
    }
    setPending(true);
    try {
      await apiRequest(`/api/trash/${encodeURIComponent(chat.id)}/restore`, {
        method: "POST", action: "Restore chat", fallbackMessage: "Failed to restore chat",
      });
      await refreshChats();
      navigate({ view: "chat", chatId: chat.id });
      toast.success("Chat restored");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setPending(false);
    }
  }, [navigate, refreshChats, toast, canModify]);

  async function confirmDelete(): Promise<void> {
    if (!target) return;
    if (target !== "all" && !canModify(target)) {
      toast.error("This workspace is read-only.");
      return;
    }
    setPending(true);
    try {
      const all = target === "all";
      const result = await apiRequest<ChatTrashResult>(
        all ? "/api/trash" : `/api/trash/${encodeURIComponent(target.id)}`,
        {
          method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
          action: "Permanently delete chat", fallbackMessage: "Failed to permanently delete chat",
        },
      );
      setTarget(null);
      navigate({ view: "trash" });
      if (all && result.failedCount > 0) {
        toast.error(`Deleted ${result.deletedCount} chats. Some chats could not be cleaned up and remain in Trash.`);
      } else {
        toast.success(all ? "Local Trash emptied" : "Chat permanently deleted");
      }
    } catch (error) {
      toast.error(String(error));
    } finally {
      setPending(false);
    }
  }

  const items = useCallback((chat: TrashedChat): ActionMenuItem[] => !canModify(chat) ? [] : [
    { id: "restore", label: "Restore", disabled: pending, onAction: () => void restore(chat) },
    { id: "delete-permanently", label: "Delete permanently", destructive: true, disabled: pending, onAction: () => setTarget(chat) },
  ], [pending, restore, canModify]);
  const emptyActions = useMemo<ActionMenuItem[]>(() => [{
    id: "empty-trash", label: "Empty local Trash", destructive: true, disabled: pending,
    onAction: () => setTarget("all"),
  }], [pending]);

  return {
    restore, items, emptyActions, pending, canModify,
    requestDelete: (chat: TrashedChat) => setTarget(chat),
    requestEmpty: () => setTarget("all"),
    dialogs: (
      <ConfirmModal
        isOpen={target !== null && (target === "all" || canModify(target))}
        onClose={() => { if (!pending) setTarget(null); }}
        onConfirm={confirmDelete}
        title={target === "all" ? "Empty local Trash?" : "Delete chat permanently?"}
        message={target === "all"
          ? "Permanently delete all chats owned by this instance, including hidden private chats, and their managed worktrees? Shared chats on other controllers are not deleted. This cannot be undone."
          : `Permanently delete "${target?.name ?? "this chat"}" and its managed worktree? This cannot be undone.`}
        confirmLabel={target === "all" ? "Empty local Trash" : "Delete permanently"}
        loading={pending}
        variant="danger"
      />
    ),
  };
}

export type ChatTrashActions = ReturnType<typeof useChatTrashActions>;
