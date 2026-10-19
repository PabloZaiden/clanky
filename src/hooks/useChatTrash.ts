import type { ChatTrashPage } from "@/contracts/schemas/chat-trash";
import { apiRequest } from "../lib/api-client";
import { useLiveQuery } from "@pablozaiden/webapp/web";

export function useChatTrash(showPrivateItems: boolean, cursor?: string) {
  const query = new URLSearchParams({ limit: "30", includePrivate: String(showPrivateItems) });
  if (cursor) query.set("cursor", cursor);
  const url = `/api/trash?${query}`;

  const queryOwner = useLiveQuery<ChatTrashPage>({
    load: (signal) => apiRequest<ChatTrashPage>(url, {
      signal,
      action: "Fetch Trash",
      fallbackMessage: "Failed to fetch Trash",
    }),
    deps: [url],
    realtime: { resources: ["trash"] },
  });
  return {
    ...(queryOwner.data ?? { items: [], nextCursor: null }),
    loading: queryOwner.data === undefined && queryOwner.loading,
    error: queryOwner.error ? String(queryOwner.error) : null,
    refresh: queryOwner.refresh,
  };
}

export type UseChatTrashResult = ReturnType<typeof useChatTrash>;
