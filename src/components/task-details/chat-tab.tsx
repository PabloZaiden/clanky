import { useEffect, useState } from "react";
import { appFetch } from "../../lib/public-path";
import type { Chat } from "@/shared";
import { ChatDetails } from "../ChatDetails";

async function parseError(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json() as { message?: string; error?: string };
    return data.message ?? data.error ?? fallback;
  } catch {
    return fallback;
  }
}

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
        const response = await appFetch(`/api/tasks/${taskId}/chat`, {
          method: "POST",
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return;
        }
        if (!response.ok) {
          throw new Error(await parseError(response, "Failed to load task chat"));
        }
        const chat = await response.json() as Chat;
        setChatId(chat.config.id);
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
