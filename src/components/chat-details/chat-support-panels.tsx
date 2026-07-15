import { useRef, useState } from "react";
import type { Chat } from "@/shared";
import { useToast } from "@pablozaiden/webapp/web";
import { appFetch } from "../../lib/public-path";
import { Button } from "../common";
import { getChatErrorMessage, parseChatError } from "./chat-lifecycle";
import type {
  ChatPermissionPanelProps,
  ChatQueuedMessagesPanelProps,
} from "./types";

export function ChatPermissionPanel({
  chatId,
  requests,
  onChatSnapshot,
}: ChatPermissionPanelProps) {
  const toast = useToast();
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const pendingIdsRef = useRef(new Set<string>());
  const pendingRequests = requests.filter((permissionRequest) => permissionRequest.status === "pending");

  async function handleReply(requestId: string, decision: "allow" | "deny"): Promise<void> {
    if (pendingIdsRef.current.has(requestId)) {
      return;
    }

    pendingIdsRef.current.add(requestId);
    setPendingIds((current) => [...current, requestId]);
    try {
      const response = await appFetch(`/api/chats/${chatId}/permissions/${encodeURIComponent(requestId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!response.ok) {
        throw new Error(await parseChatError(response, "Failed to reply to permission request"));
      }
      const nextChat = (await response.json()) as Chat;
      onChatSnapshot(nextChat);
    } catch (permissionError) {
      toast.error(getChatErrorMessage(permissionError));
    } finally {
      pendingIdsRef.current.delete(requestId);
      setPendingIds((current) => current.filter((id) => id !== requestId));
    }
  }

  if (pendingRequests.length === 0) {
    return null;
  }

  return (
    <div className="border-t border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/30">
      <div className="mx-auto max-w-4xl space-y-3">
        {pendingRequests.map((permissionRequest) => {
          const isReplying = pendingIds.includes(permissionRequest.requestId);
          return (
            <div
              key={permissionRequest.requestId}
              className="rounded-md border border-amber-200 bg-white p-3 shadow-sm dark:border-amber-900/70 dark:bg-neutral-900"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-amber-900 dark:text-amber-200">
                    Provider requests permission: {permissionRequest.permission}
                  </p>
                  {permissionRequest.patterns.length > 0 && (
                    <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-amber-100 p-2 font-mono text-xs text-amber-950 dark:bg-amber-950 dark:text-amber-100">
                      {permissionRequest.patterns.join("\n")}
                    </pre>
                  )}
                  {permissionRequest.error && (
                    <p className="mt-2 text-xs text-red-700 dark:text-red-300">
                      {permissionRequest.error}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void handleReply(permissionRequest.requestId, "deny")}
                    disabled={isReplying}
                  >
                    Deny
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void handleReply(permissionRequest.requestId, "allow")}
                    disabled={isReplying}
                    loading={isReplying}
                  >
                    Allow
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ChatQueuedMessagesPanel({
  chatId,
  messages,
  onChatSnapshot,
}: ChatQueuedMessagesPanelProps) {
  const toast = useToast();
  const [removingIds, setRemovingIds] = useState<string[]>([]);

  async function handleRemove(queuedMessageId: string): Promise<void> {
    if (removingIds.includes(queuedMessageId)) {
      return;
    }

    setRemovingIds((current) => [...current, queuedMessageId]);
    try {
      const response = await appFetch(`/api/chats/${chatId}/queued-messages/${encodeURIComponent(queuedMessageId)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(await parseChatError(response, "Failed to remove queued message"));
      }
      const nextChat = (await response.json()) as Chat;
      onChatSnapshot(nextChat);
    } catch (removeError) {
      toast.error(getChatErrorMessage(removeError));
    } finally {
      setRemovingIds((current) => current.filter((id) => id !== queuedMessageId));
    }
  }

  if (messages.length === 0) {
    return null;
  }

  return (
    <div className="px-4 py-3">
      <div className="mx-auto max-w-4xl space-y-2">
        {messages.map((queuedMessage, index) => {
          const isRemoving = removingIds.includes(queuedMessage.id);
          const attachmentCount = queuedMessage.attachments?.length ?? 0;
          return (
            <div
              key={queuedMessage.id}
              className="relative rounded-md border border-dashed border-amber-300 bg-white px-3 py-2 pr-10 text-sm shadow-sm dark:border-amber-800/80 dark:bg-neutral-900"
            >
              <div className="mb-1 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
                <span>Queue #{index + 1}</span>
                {attachmentCount > 0 && (
                  <span>{attachmentCount} image{attachmentCount === 1 ? "" : "s"}</span>
                )}
              </div>
              {queuedMessage.content.trim().length > 0 && (
                <p className="whitespace-pre-wrap break-words text-gray-900 dark:text-gray-100">
                  {queuedMessage.content}
                </p>
              )}
              <button
                type="button"
                onClick={() => void handleRemove(queuedMessage.id)}
                disabled={isRemoving}
                className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-400 dark:hover:bg-neutral-800 dark:hover:text-gray-100"
                aria-label="Remove queued message"
                title="Remove queued message"
              >
                <span className="text-base leading-none">×</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
