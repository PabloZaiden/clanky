import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatTrashPage } from "@/contracts/schemas/chat-trash";
import { apiRequest } from "../lib/api-client";
import { useRealtimeRefreshWithRecovery } from "./useRealtimeStream";
import { useRefreshOnForeground } from "./useDocumentVisibility";

export function useChatTrash(showPrivateItems: boolean, cursor?: string) {
  const [page, setPage] = useState<ChatTrashPage>({ items: [], nextCursor: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const query = new URLSearchParams({ limit: "30", includePrivate: String(showPrivateItems) });
  if (cursor) query.set("cursor", cursor);
  const url = `/api/trash?${query}`;

  const refresh = useCallback(async (): Promise<void> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const data = await apiRequest<ChatTrashPage>(url, {
        signal: controller.signal,
        action: "Fetch Trash",
        fallbackMessage: "Failed to fetch Trash",
      });
      if (!controller.signal.aborted) {
        setPage(data);
        setError(null);
      }
    } catch (error) {
      if (!controller.signal.aborted) setError(String(error));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    setLoading(true);
    setPage({ items: [], nextCursor: null });
    void refresh();
    return () => controllerRef.current?.abort();
  }, [refresh]);

  useRealtimeRefreshWithRecovery({
    resources: ["trash"],
    refresh,
    onReconnect: refresh,
  });
  useRefreshOnForeground(refresh);
  return { ...page, loading, error, refresh };
}

export type UseChatTrashResult = ReturnType<typeof useChatTrash>;
