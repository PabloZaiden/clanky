import { useMemo, useState, type ReactNode } from "react";
import { ConfirmModal, Modal, getWebAppClientMode, useToast, type ActionMenuItem } from "@pablozaiden/webapp/web";
import { Button } from "../common";
import { RenameChatModal } from "../RenameChatModal";
import { appResourceUrl, appSaveResource } from "../../lib/public-path";
import { apiRequest } from "../../lib/api-client";
import type { Chat } from "@/shared";
import {
  getCurrentChatDirectory,
  isChatBusyStatus,
  isStandaloneChat,
} from "@/shared/chat";

interface ChatActionItemOptions {
  chat: Chat;
  hasCodeExplorerAction: boolean;
  sameDirectoryChatPending: boolean;
  markDonePending: boolean;
  onCreateSameDirectoryChat: () => void;
  onOpenCodeExplorer: () => void;
  onTranscript: () => void;
  onRename: () => void;
  onMarkDone: () => void;
  onDelete: () => void;
}

interface UseChatActionsOptions {
  chat: Chat | null;
  hasCodeExplorerAction: boolean;
  onOpenCodeExplorer?: (chat: Chat) => void;
  onCreateChatInCurrentDirectory: (chat: Chat, directory: string) => Promise<void>;
  onChatRenamed?: (chat: Chat) => void | Promise<void>;
  onChatDone?: (chat: Chat) => Chat | null | Promise<Chat | null>;
  onDeleteChat: (chatId: string) => Promise<boolean>;
  onChatDeleted?: (chat: Chat) => void | Promise<void>;
  onActionError: (message: string) => void;
}

interface ChatActionsController {
  items: ActionMenuItem[];
  modals: ReactNode;
  isDeletePending: boolean;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildChatActionItems({
  chat,
  hasCodeExplorerAction,
  sameDirectoryChatPending,
  markDonePending,
  onCreateSameDirectoryChat,
  onOpenCodeExplorer,
  onTranscript,
  onRename,
  onMarkDone,
  onDelete,
}: ChatActionItemOptions): ActionMenuItem[] {
  const isActive = isChatBusyStatus(chat.state.status) || chat.state.status === "reconnecting";
  const hasMessages = chat.state.hasMessages ?? chat.state.messages.length > 0;
  const hasTranscript = chat.state.hasTranscript ?? (hasMessages || chat.state.toolCalls.length > 0);
  const canCreateSameDirectoryChat = Boolean(getCurrentChatDirectory(chat));

  return [
    {
      id: "new-chat-current-directory",
      label: sameDirectoryChatPending ? "Creating chat..." : "New Chat here",
      onAction: onCreateSameDirectoryChat,
      disabled: sameDirectoryChatPending || !canCreateSameDirectoryChat,
    },
    {
      id: "code-explorer",
      label: "Code explorer",
      onAction: onOpenCodeExplorer,
      disabled: !hasCodeExplorerAction,
    },
    {
      id: "rename",
      label: "Rename",
      onAction: onRename,
    },
    {
      id: "transcript",
      label: "Transcript",
      onAction: onTranscript,
      disabled: !hasTranscript,
    },
    ...(isStandaloneChat(chat) && chat.state.status !== "done" ? [{
      id: "mark-done",
      label: markDonePending ? "Marking as Done..." : "Mark as Done",
      onAction: onMarkDone,
      disabled: isActive || markDonePending,
    }] : []),
    {
      id: "delete",
      label: "Delete",
      onAction: onDelete,
      destructive: true,
    },
  ];
}

export function useChatActions({
  chat,
  hasCodeExplorerAction,
  onOpenCodeExplorer,
  onCreateChatInCurrentDirectory,
  onChatRenamed,
  onChatDone,
  onDeleteChat,
  onChatDeleted,
  onActionError,
}: UseChatActionsOptions): ChatActionsController {
  const toast = useToast();
  const browserOnly = getWebAppClientMode() === "external";
  const [renameTarget, setRenameTarget] = useState<Chat | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Chat | null>(null);
  const [transcriptTarget, setTranscriptTarget] = useState<Chat | null>(null);
  const [isDeletePending, setIsDeletePending] = useState(false);
  const [isMarkDonePending, setIsMarkDonePending] = useState(false);
  const [isSameDirectoryChatPending, setIsSameDirectoryChatPending] = useState(false);
  const [isTranscriptPending, setIsTranscriptPending] = useState(false);

  async function openTranscript(format: "view" | "download"): Promise<void> {
    if (!transcriptTarget || isTranscriptPending) return;
    const popup = format === "view" && !browserOnly ? window.open("about:blank", "_blank") : null;
    if (format === "view" && !browserOnly && !popup) {
      onActionError("Allow pop-ups to open the transcript.");
      return;
    }
    if (popup) popup.opener = null;
    setIsTranscriptPending(true);
    try {
      const suffix = format === "view" ? "transcript.html" : "transcript.md?download=1";
      const path = `/api/chats/${encodeURIComponent(transcriptTarget.config.id)}/${suffix}`;
      if (popup) {
        const resource = await appResourceUrl(path);
        popup.location.replace(resource.url);
      } else {
        await appSaveResource(path, { suggestedName: `transcript.${format === "view" ? "html" : "md"}` });
        if (browserOnly) toast.success("Transcript is ready to export in Settings > Downloads.");
      }
      setTranscriptTarget(null);
    } catch (error) {
      popup?.close();
      onActionError(getErrorMessage(error));
    } finally {
      setIsTranscriptPending(false);
    }
  }

  async function handleRename(newName: string): Promise<void> {
    if (!renameTarget) {
      return;
    }

    const updatedChat = await apiRequest<Chat>(`/api/chats/${encodeURIComponent(renameTarget.config.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
      action: "Rename chat",
      fallbackMessage: "Failed to rename chat",
    });
    await onChatRenamed?.(updatedChat);
  }

  async function confirmDeleteChat(): Promise<void> {
    if (!deleteTarget || isDeletePending) {
      return;
    }

    const target = deleteTarget;
    setIsDeletePending(true);
    try {
      const deleted = await onDeleteChat(target.config.id);
      if (!deleted) {
        onActionError("Failed to delete chat");
        return;
      }
      setDeleteTarget(null);
      await onChatDeleted?.(target);
    } catch (error) {
      onActionError(getErrorMessage(error));
    } finally {
      setIsDeletePending(false);
    }
  }

  async function markChatDone(target: Chat): Promise<void> {
    if (isMarkDonePending || target.state.status === "done" || !isStandaloneChat(target)) {
      return;
    }

    setIsMarkDonePending(true);
    try {
      const updated = await onChatDone?.(target);
      if (!updated) {
        throw new Error("Failed to mark chat as done");
      }
    } catch (error) {
      onActionError(getErrorMessage(error));
    } finally {
      setIsMarkDonePending(false);
    }
  }

  async function createChatInCurrentDirectory(target: Chat): Promise<void> {
    if (isSameDirectoryChatPending) {
      return;
    }

    const directory = getCurrentChatDirectory(target);
    if (!directory) {
      onActionError("The current chat worktree is not ready yet.");
      return;
    }

    setIsSameDirectoryChatPending(true);
    try {
      await onCreateChatInCurrentDirectory(target, directory);
    } catch (error) {
      onActionError(getErrorMessage(error));
    } finally {
      setIsSameDirectoryChatPending(false);
    }
  }

  const items = useMemo(() => {
    if (!chat) {
      return [];
    }

    return buildChatActionItems({
      chat,
      hasCodeExplorerAction,
      sameDirectoryChatPending: isSameDirectoryChatPending,
      markDonePending: isMarkDonePending,
      onCreateSameDirectoryChat: () => void createChatInCurrentDirectory(chat),
      onOpenCodeExplorer: () => onOpenCodeExplorer?.(chat),
      onTranscript: () => setTranscriptTarget(chat),
      onRename: () => setRenameTarget(chat),
      onMarkDone: () => void markChatDone(chat),
      onDelete: () => setDeleteTarget(chat),
    });
  }, [
    chat,
    hasCodeExplorerAction,
    isSameDirectoryChatPending,
    isMarkDonePending,
    onCreateChatInCurrentDirectory,
    onActionError,
    onChatDeleted,
    onDeleteChat,
    onOpenCodeExplorer,
  ]);

  const modals = (
    <>
      <RenameChatModal
        isOpen={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        currentName={renameTarget?.config.name ?? ""}
        onRename={handleRename}
      />
      <ConfirmModal
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDeleteChat()}
        title="Delete chat?"
        message={deleteTarget && isStandaloneChat(deleteTarget)
          ? `Move "${deleteTarget.config.name}" to Trash? You can restore it for 30 days. Active work will stop; its history and worktree will be kept until permanent deletion.`
          : `Delete "${deleteTarget?.config.name ?? "this chat"}"? This removes the saved chat session, transcript, and any worktree created for it.`}
        confirmLabel="Delete"
        variant={deleteTarget && isStandaloneChat(deleteTarget) ? "primary" : "danger"}
        loading={isDeletePending}
      />
      <Modal
        isOpen={transcriptTarget !== null}
        onClose={() => setTranscriptTarget(null)}
        title="Transcript"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setTranscriptTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              disabled={isTranscriptPending}
              onClick={() => void openTranscript("download")}
            >
              Download
            </Button>
            <Button
              disabled={isTranscriptPending}
              onClick={() => void openTranscript("view")}
            >
              {browserOnly ? "Download HTML" : "View"}
            </Button>
          </>
        }
      >
        <></>
        <p>{browserOnly ? "Download the transcript as Markdown or HTML." : "Open the transcript in a standalone window or download it as a Markdown file."}</p>
      </Modal>
    </>
  );

  return { items, modals, isDeletePending };
}