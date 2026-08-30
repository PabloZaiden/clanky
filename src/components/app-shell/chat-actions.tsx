import { useMemo, useState, type ReactNode } from "react";
import { ConfirmModal, Modal, type ActionMenuItem } from "@pablozaiden/webapp/web";
import { Button } from "../common";
import { RenameChatModal } from "../RenameChatModal";
import { SpawnCurrentPlanModal } from "../SpawnCurrentPlanModal";
import { appAbsoluteUrl } from "../../lib/public-path";
import { apiRequest } from "../../lib/api-client";
import type { Chat, Task } from "@/shared";
import { isChatBusyStatus, isStandaloneChat } from "@/shared/chat";

interface ChatActionItemOptions {
  chat: Chat;
  canSpawnTasks: boolean;
  hasCodeExplorerAction: boolean;
  spawnPending: boolean;
  spawnCurrentPlanPending: boolean;
  markDonePending: boolean;
  onSpawnTask: () => void;
  onSpawnTaskFromCurrentPlan: () => void;
  onOpenCodeExplorer: () => void;
  onTranscript: () => void;
  onRename: () => void;
  onMarkDone: () => void;
  onDelete: () => void;
}

interface UseChatActionsOptions {
  chat: Chat | null;
  canSpawnTasks: boolean;
  hasCodeExplorerAction: boolean;
  onOpenCodeExplorer?: (chat: Chat) => void;
  onTaskSpawned?: (task: Task) => void;
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

function getChatTranscriptViewerUrl(chat: Chat): string {
  return appAbsoluteUrl(`/api/chats/${encodeURIComponent(chat.config.id)}/transcript.html`);
}

function getChatTranscriptDownloadUrl(chat: Chat): string {
  return appAbsoluteUrl(`/api/chats/${encodeURIComponent(chat.config.id)}/transcript.md?download=1`);
}

function buildChatActionItems({
  chat,
  canSpawnTasks,
  hasCodeExplorerAction,
  spawnPending,
  spawnCurrentPlanPending,
  markDonePending,
  onSpawnTask,
  onSpawnTaskFromCurrentPlan,
  onOpenCodeExplorer,
  onTranscript,
  onRename,
  onMarkDone,
  onDelete,
}: ChatActionItemOptions): ActionMenuItem[] {
  const isActive = isChatBusyStatus(chat.state.status) || chat.state.status === "reconnecting";
  const hasMessages = chat.state.hasMessages ?? chat.state.messages.length > 0;
  const hasTranscript = chat.state.hasTranscript ?? (hasMessages || chat.state.toolCalls.length > 0);

  const taskActions: ActionMenuItem[] = canSpawnTasks ? [
    {
      id: "spawn-task",
      label: spawnPending ? "Spawning task..." : "Spawn Task",
      onAction: onSpawnTask,
      disabled: isActive || spawnPending || spawnCurrentPlanPending || !hasMessages,
    },
    {
      id: "spawn-task-from-current-plan",
      label: spawnCurrentPlanPending ? "Spawning task from plan file..." : "Spawn task from plan file",
      onAction: onSpawnTaskFromCurrentPlan,
      disabled: isActive || spawnPending || spawnCurrentPlanPending || !hasMessages,
    },
  ] : [];

  return [
    ...taskActions,
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
  canSpawnTasks,
  hasCodeExplorerAction,
  onOpenCodeExplorer,
  onTaskSpawned,
  onChatRenamed,
  onChatDone,
  onDeleteChat,
  onChatDeleted,
  onActionError,
}: UseChatActionsOptions): ChatActionsController {
  const [renameTarget, setRenameTarget] = useState<Chat | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Chat | null>(null);
  const [transcriptTarget, setTranscriptTarget] = useState<Chat | null>(null);
  const [spawnCurrentPlanTarget, setSpawnCurrentPlanTarget] = useState<Chat | null>(null);
  const [spawnCurrentPlanPath, setSpawnCurrentPlanPath] = useState("");
  const [isSpawnPending, setIsSpawnPending] = useState(false);
  const [isSpawnCurrentPlanPending, setIsSpawnCurrentPlanPending] = useState(false);
  const [isDeletePending, setIsDeletePending] = useState(false);
  const [isMarkDonePending, setIsMarkDonePending] = useState(false);

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

  async function spawnTask(target: Chat): Promise<void> {
    if (!canSpawnTasks || isSpawnPending || isSpawnCurrentPlanPending) {
      return;
    }

    setIsSpawnPending(true);
    try {
      const task = await apiRequest<Task>(`/api/chats/${encodeURIComponent(target.config.id)}/spawn-task`, {
        method: "POST",
        action: "Spawn task from chat",
        fallbackMessage: "Failed to spawn task",
      });
      onTaskSpawned?.(task);
    } catch (error) {
      onActionError(getErrorMessage(error));
    } finally {
      setIsSpawnPending(false);
    }
  }

  function openSpawnCurrentPlanModal(target: Chat): void {
    if (!canSpawnTasks || isSpawnPending || isSpawnCurrentPlanPending) {
      return;
    }

    setSpawnCurrentPlanPath("");
    setSpawnCurrentPlanTarget(target);
  }

  function closeSpawnCurrentPlanModal(): void {
    if (isSpawnCurrentPlanPending) {
      return;
    }

    setSpawnCurrentPlanTarget(null);
    setSpawnCurrentPlanPath("");
  }

  async function spawnTaskFromCurrentPlan(requestedPlanPath: string): Promise<void> {
    if (!canSpawnTasks || !spawnCurrentPlanTarget || isSpawnPending || isSpawnCurrentPlanPending) {
      return;
    }

    const trimmedPlanPath = requestedPlanPath.trim();
    setIsSpawnCurrentPlanPending(true);
    try {
      const task = await apiRequest<Task>(`/api/chats/${encodeURIComponent(spawnCurrentPlanTarget.config.id)}/spawn-task-from-current-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(trimmedPlanPath ? { planFilePath: trimmedPlanPath } : {}),
        action: "Spawn task from current plan",
        fallbackMessage: "Failed to spawn task from current plan",
      });
      setSpawnCurrentPlanTarget(null);
      setSpawnCurrentPlanPath("");
      onTaskSpawned?.(task);
    } catch (error) {
      onActionError(getErrorMessage(error));
    } finally {
      setIsSpawnCurrentPlanPending(false);
    }
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

  const items = useMemo(() => {
    if (!chat) {
      return [];
    }

    return buildChatActionItems({
      chat,
      canSpawnTasks,
      hasCodeExplorerAction,
      spawnPending: isSpawnPending,
      spawnCurrentPlanPending: isSpawnCurrentPlanPending,
      markDonePending: isMarkDonePending,
      onSpawnTask: () => void spawnTask(chat),
      onSpawnTaskFromCurrentPlan: () => openSpawnCurrentPlanModal(chat),
      onOpenCodeExplorer: () => onOpenCodeExplorer?.(chat),
      onTranscript: () => setTranscriptTarget(chat),
      onRename: () => setRenameTarget(chat),
      onMarkDone: () => void markChatDone(chat),
      onDelete: () => setDeleteTarget(chat),
    });
  }, [
    canSpawnTasks,
    chat,
    hasCodeExplorerAction,
    isMarkDonePending,
    isSpawnCurrentPlanPending,
    isSpawnPending,
    onActionError,
    onChatDeleted,
    onDeleteChat,
    onOpenCodeExplorer,
    onTaskSpawned,
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
        message={`Delete "${deleteTarget?.config.name ?? "this chat"}"? This removes the saved chat session, transcript, and any worktree created for it.`}
        confirmLabel="Delete"
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
              onClick={() => {
                if (transcriptTarget) {
                  window.open(getChatTranscriptDownloadUrl(transcriptTarget), "_blank", "noopener,noreferrer");
                }
                setTranscriptTarget(null);
              }}
            >
              Download
            </Button>
            <Button
              onClick={() => {
                if (transcriptTarget) {
                  window.open(getChatTranscriptViewerUrl(transcriptTarget), "_blank", "noopener,noreferrer");
                }
                setTranscriptTarget(null);
              }}
            >
              View
            </Button>
          </>
        }
      >
        <></>
        <p>Open the transcript in a standalone window or download it as a Markdown file.</p>
      </Modal>
      {canSpawnTasks ? (
        <SpawnCurrentPlanModal
          isOpen={spawnCurrentPlanTarget !== null}
          submitting={isSpawnCurrentPlanPending}
          initialPlanFilePath={spawnCurrentPlanPath}
          onClose={closeSpawnCurrentPlanModal}
          onSubmit={async (planFilePath) => {
            setSpawnCurrentPlanPath(planFilePath);
            await spawnTaskFromCurrentPlan(planFilePath);
          }}
        />
      ) : null}
    </>
  );

  return { items, modals, isDeletePending };
}