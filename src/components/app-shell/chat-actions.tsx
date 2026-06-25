import { useMemo, useState, type ReactNode } from "react";
import { ConfirmModal, Modal, type ActionMenuItem } from "@pablozaiden/webapp/web";
import { Button } from "../common";
import { RenameChatModal } from "../RenameChatModal";
import { SpawnCurrentPlanModal } from "../SpawnCurrentPlanModal";
import { appAbsoluteUrl, appFetch } from "../../lib/public-path";
import type { Chat, Task } from "../../types";

interface ChatActionItemOptions {
  chat: Chat;
  hasCodeExplorerAction: boolean;
  spawnPending: boolean;
  spawnCurrentPlanPending: boolean;
  onSpawnTask: () => void;
  onSpawnTaskFromCurrentPlan: () => void;
  onOpenCodeExplorer: () => void;
  onTranscript: () => void;
  onRename: () => void;
  onDelete: () => void;
}

interface UseChatActionsOptions {
  chat: Chat | null;
  hasCodeExplorerAction: boolean;
  onOpenCodeExplorer?: (chat: Chat) => void;
  onTaskSpawned?: (task: Task) => void;
  onChatRenamed?: (chat: Chat) => void | Promise<void>;
  onChatDeleted?: (chat: Chat) => void | Promise<void>;
  onActionError: (message: string) => void;
}

interface ChatActionsController {
  items: ActionMenuItem[];
  modals: ReactNode;
  isDeletePending: boolean;
}

async function parseError(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json() as { message?: string; error?: string };
    return data.message ?? data.error ?? fallback;
  } catch {
    return fallback;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getChatTranscriptViewerUrl(chat: Chat): string {
  return appAbsoluteUrl(`/#/chat-transcript/${encodeURIComponent(chat.config.id)}`);
}

function getChatTranscriptDownloadUrl(chat: Chat): string {
  return appAbsoluteUrl(`/api/chats/${encodeURIComponent(chat.config.id)}/transcript.md?download=1`);
}

function buildChatActionItems({
  chat,
  hasCodeExplorerAction,
  spawnPending,
  spawnCurrentPlanPending,
  onSpawnTask,
  onSpawnTaskFromCurrentPlan,
  onOpenCodeExplorer,
  onTranscript,
  onRename,
  onDelete,
}: ChatActionItemOptions): ActionMenuItem[] {
  const isActive = ["starting", "streaming", "interrupting", "reconnecting"].includes(chat.state.status);
  const hasMessages = chat.state.messages.length > 0;

  return [
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
      disabled: !hasMessages,
    },
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
  onTaskSpawned,
  onChatRenamed,
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

  async function handleRename(newName: string): Promise<void> {
    if (!renameTarget) {
      return;
    }

    const response = await appFetch(`/api/chats/${encodeURIComponent(renameTarget.config.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    if (!response.ok) {
      throw new Error(await parseError(response, "Failed to rename chat"));
    }
    const updatedChat = (await response.json()) as Chat;
    await onChatRenamed?.(updatedChat);
  }

  async function spawnTask(target: Chat): Promise<void> {
    if (isSpawnPending || isSpawnCurrentPlanPending) {
      return;
    }

    setIsSpawnPending(true);
    try {
      const response = await appFetch(`/api/chats/${encodeURIComponent(target.config.id)}/spawn-task`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to spawn task"));
      }
      const task = (await response.json()) as Task;
      onTaskSpawned?.(task);
    } catch (error) {
      onActionError(getErrorMessage(error));
    } finally {
      setIsSpawnPending(false);
    }
  }

  function openSpawnCurrentPlanModal(target: Chat): void {
    if (isSpawnPending || isSpawnCurrentPlanPending) {
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
    if (!spawnCurrentPlanTarget || isSpawnPending || isSpawnCurrentPlanPending) {
      return;
    }

    const trimmedPlanPath = requestedPlanPath.trim();
    setIsSpawnCurrentPlanPending(true);
    try {
      const response = await appFetch(`/api/chats/${encodeURIComponent(spawnCurrentPlanTarget.config.id)}/spawn-task-from-current-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(trimmedPlanPath ? { planFilePath: trimmedPlanPath } : {}),
      });
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to spawn task from current plan"));
      }
      const task = (await response.json()) as Task;
      setSpawnCurrentPlanTarget(null);
      setSpawnCurrentPlanPath("");
      onTaskSpawned?.(task);
    } catch (error) {
      onActionError(getErrorMessage(error));
    } finally {
      setIsSpawnCurrentPlanPending(false);
    }
  }

  async function deleteChat(): Promise<void> {
    if (!deleteTarget || isDeletePending) {
      return;
    }

    const target = deleteTarget;
    setIsDeletePending(true);
    try {
      const response = await appFetch(`/api/chats/${encodeURIComponent(target.config.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to delete chat"));
      }
      setDeleteTarget(null);
      await onChatDeleted?.(target);
    } catch (error) {
      onActionError(getErrorMessage(error));
    } finally {
      setIsDeletePending(false);
    }
  }

  const items = useMemo(() => {
    if (!chat) {
      return [];
    }

    return buildChatActionItems({
      chat,
      hasCodeExplorerAction,
      spawnPending: isSpawnPending,
      spawnCurrentPlanPending: isSpawnCurrentPlanPending,
      onSpawnTask: () => void spawnTask(chat),
      onSpawnTaskFromCurrentPlan: () => openSpawnCurrentPlanModal(chat),
      onOpenCodeExplorer: () => onOpenCodeExplorer?.(chat),
      onTranscript: () => setTranscriptTarget(chat),
      onRename: () => setRenameTarget(chat),
      onDelete: () => setDeleteTarget(chat),
    });
  }, [chat, hasCodeExplorerAction, isSpawnCurrentPlanPending, isSpawnPending, onActionError, onOpenCodeExplorer, onTaskSpawned]);

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
        onConfirm={() => void deleteChat()}
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
        <p>Open the raw markdown transcript in a new window or download it as a file.</p>
      </Modal>
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
    </>
  );

  return { items, modals, isDeletePending };
}