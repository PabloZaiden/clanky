import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api-client";
import { ChatDetails } from "../ChatDetails";

export function ChatTab({ taskId }: { taskId: string }) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadTaskChat(): Promise<void> {
      try {
        setLoading(true);
        setError(null);
        const data = await apiRequest<{ chatId?: string }>(`/api/tasks/${taskId}/chat?summary=1`, {
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
  }, [taskId]);

  if (loading && !chatId) {
    return <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading chat…</div>;
  }

  if (!chatId) {
    return (
      <div className="p-6 text-sm text-red-600 dark:text-red-400">
        {error ?? "Failed to load task chat"}
      </div>
    );
  }

  return <ChatDetails chatId={chatId} embeddedTaskId={taskId} showBackButton={false} />;
}
