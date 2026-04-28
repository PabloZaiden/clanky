import { useEffect, useState } from "react";
import { useToast } from "../../hooks";
import { appFetch } from "../../lib/public-path";
import type { Chat } from "../../types";
import { ChatDetails } from "../ChatDetails";

async function parseError(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json() as { message?: string; error?: string };
    return data.message ?? data.error ?? fallback;
  } catch {
    return fallback;
  }
}

export function ChatTab({ loopId }: { loopId: string }) {
  const { error: showErrorToast } = useToast();
  const [chatId, setChatId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadLoopChat(): Promise<void> {
      try {
        setLoading(true);
        setError(null);
        const response = await appFetch(`/api/loops/${loopId}/chat`, {
          method: "POST",
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return;
        }
        if (!response.ok) {
          throw new Error(await parseError(response, "Failed to load loop chat"));
        }
        const chat = await response.json() as Chat;
        setChatId(chat.config.id);
      } catch (loadError) {
        if (loadError instanceof DOMException && loadError.name === "AbortError") {
          return;
        }
        const message = String(loadError);
        setError(message);
        showErrorToast(message);
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    void loadLoopChat();

    return () => {
      controller.abort();
    };
  }, [loopId, showErrorToast]);

  if (loading && !chatId) {
    return <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading chat…</div>;
  }

  if (!chatId) {
    return (
      <div className="p-6 text-sm text-red-600 dark:text-red-400">
        {error ?? "Failed to load loop chat"}
      </div>
    );
  }

  return <ChatDetails chatId={chatId} embeddedLoopId={loopId} showBackButton={false} />;
}
