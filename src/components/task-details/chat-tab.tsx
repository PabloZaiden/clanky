import { useEffect, useState } from "react";
import { EmptyState } from "@pablozaiden/webapp/web";
import { apiRequest } from "../../lib/api-client";
import { ApiError } from "../../lib/api-error";
import { ChatDetails } from "../ChatDetails";
import type { Chat } from "@/shared";
import { useWorkspaceReadOnly } from "../../context/workspace-access-context";

export function ChatTab({ taskId, active }: { taskId: string; active: boolean }) {
  const readOnly = useWorkspaceReadOnly();
  const [chatId, setChatId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadTaskChat(): Promise<void> {
      try {
        setLoading(true);
        setError(null);
        setChatId(null);
        const data = readOnly
          ? { chatId: (await apiRequest<Chat>(`/api/tasks/${encodeURIComponent(taskId)}/chat`, {
            signal: controller.signal, action: "Load task chat",
          })).config.id }
          : await apiRequest<{ chatId?: string }>(`/api/tasks/${taskId}/chat?summary=1`, {
            method: "POST",
            signal: controller.signal,
            action: "Load task chat",
            fallbackMessage: "Failed to load task chat",
          });
        if (controller.signal.aborted) {
          return;
        }
        if (!data.chatId) {
          throw new Error("Task chat response did not include a chat ID");
        }
        setChatId(data.chatId);
      } catch (loadError) {
        if (loadError instanceof DOMException && loadError.name === "AbortError") {
          return;
        }
        if (readOnly && loadError instanceof ApiError && loadError.status === 404) {
          return;
        }
        const message = String(loadError);
        setError(message);
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    void loadTaskChat();

    return () => {
      controller.abort();
    };
  }, [taskId, readOnly]);

  if (loading && !chatId) {
    return <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading chat…</div>;
  }

  if (!chatId) {
    if (readOnly && !error) {
      return <EmptyState title="No task chat" />;
    }
    return (
      <div className="p-6 text-sm text-red-600 dark:text-red-400">
        {error ?? "Failed to load task chat"}
      </div>
    );
  }

  return <ChatDetails chatId={chatId} embeddedTaskId={taskId} isVisible={active} />;
}
