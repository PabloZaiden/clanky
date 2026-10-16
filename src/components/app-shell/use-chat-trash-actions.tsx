import { useCallback, useMemo, useState } from "react";
import { ConfirmModal, useToast, type ActionMenuItem, type WebAppRoute } from "@pablozaiden/webapp/web";
import type { ChatTrashPage, ChatTrashResult, TrashedChat } from "@/contracts/schemas/chat-trash";
import { apiRequest } from "../../lib/api-client";
import { getStoredSshCredentialToken } from "../../lib/ssh-browser-credentials";

async function cleanupCredentials(target: TrashedChat | "all"): Promise<Record<string, string>> {
  const serverIds = new Set<string>(target === "all" ? [] : target.credentialServerIds);
  if (target === "all") {
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "100", includePrivate: "true" });
      if (cursor) query.set("cursor", cursor);
      const page: ChatTrashPage = await apiRequest(`/api/trash?${query}`, {
        action: "Resolve Trash cleanup credentials", fallbackMessage: "Failed to load Trash cleanup targets",
      });
      for (const chat of page.items) {
        for (const serverId of chat.credentialServerIds) serverIds.add(serverId);
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
  const tokens: Record<string, string> = {};
  for (const serverId of serverIds) {
    const token = await getStoredSshCredentialToken(serverId);
    if (token) tokens[serverId] = token;
  }
  return tokens;
}

export function useChatTrashActions(
  navigate: (route: WebAppRoute) => void,
  refreshChats: () => Promise<void>,
) {
  const toast = useToast();
  const [target, setTarget] = useState<TrashedChat | "all" | null>(null);
  const [pending, setPending] = useState(false);

  const restore = useCallback(async (chat: TrashedChat): Promise<void> => {
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
  }, [navigate, refreshChats, toast]);

  async function confirmDelete(): Promise<void> {
    if (!target) return;
    setPending(true);
    try {
      const all = target === "all";
      const credentialTokensByServerId = await cleanupCredentials(target);
      const result = await apiRequest<ChatTrashResult>(
        all ? "/api/trash" : `/api/trash/${encodeURIComponent(target.id)}`,
        {
          method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ credentialTokensByServerId }),
          action: "Permanently delete chat", fallbackMessage: "Failed to permanently delete chat",
        },
      );
      setTarget(null);
      navigate({ view: "trash" });
      if (all && result.failedCount > 0) {
        toast.error(`Deleted ${result.deletedCount} chats. Some chats could not be cleaned up and remain in Trash.`);
      } else {
        toast.success(all ? "Trash emptied" : "Chat permanently deleted");
      }
    } catch (error) {
      toast.error(String(error));
    } finally {
      setPending(false);
    }
  }

  const items = useCallback((chat: TrashedChat): ActionMenuItem[] => [
    { id: "restore", label: "Restore", disabled: pending, onAction: () => void restore(chat) },
    { id: "delete-permanently", label: "Delete permanently", destructive: true, disabled: pending, onAction: () => setTarget(chat) },
  ], [pending, restore]);
  const emptyActions = useMemo<ActionMenuItem[]>(() => [{
    id: "empty-trash", label: "Empty Trash", destructive: true, disabled: pending,
    onAction: () => setTarget("all"),
  }], [pending]);

  return {
    restore, items, emptyActions, pending,
    requestDelete: (chat: TrashedChat) => setTarget(chat),
    requestEmpty: () => setTarget("all"),
    dialogs: (
      <ConfirmModal
        isOpen={target !== null}
        onClose={() => { if (!pending) setTarget(null); }}
        onConfirm={confirmDelete}
        title={target === "all" ? "Empty Trash?" : "Delete chat permanently?"}
        message={target === "all"
          ? "Permanently delete all chats in your Trash, including hidden private chats, and their managed worktrees? This cannot be undone."
          : `Permanently delete "${target?.name ?? "this chat"}" and its managed worktree? This cannot be undone.`}
        confirmLabel={target === "all" ? "Empty Trash" : "Delete permanently"}
        loading={pending}
        variant="danger"
      />
    ),
  };
}

export type ChatTrashActions = ReturnType<typeof useChatTrashActions>;
