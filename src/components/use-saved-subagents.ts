import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, type ResourceRealtimeEvent } from "@pablozaiden/webapp/web";
import type { Subagent, SubagentList } from "@/shared/subagent";
import { apiRequest } from "../lib/api-client";
import { createRefreshCoordinator } from "../lib/refresh-coordinator";
import { SNAPSHOT_REQUEST_TIMEOUT_MS } from "../lib/request-lifecycle";

export function useSavedSubagents(kind: "chat" | "task", entityId: string) {
  const [items, setItems] = useState<Subagent[]>([]);
  const [pages, setPages] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  const coordinator = useMemo(() => createRefreshCoordinator<void>(), [kind, entityId, pages]);
  const refresh = useCallback(() => coordinator.runAfterCurrent(async () => {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    setLoading(true);
    try {
      const all: Subagent[] = [];
      let before: string | undefined;
      for (let page = 0; page < pages; page++) {
        const result = await apiRequest<SubagentList>(
          `/api/${kind}s/${encodeURIComponent(entityId)}/subagents${before ? `?before=${encodeURIComponent(before)}` : ""}`,
          { signal: AbortSignal.any([signal, AbortSignal.timeout(SNAPSHOT_REQUEST_TIMEOUT_MS)]), action: "Load saved subagents" },
        );
        all.push(...result.items);
        before = result.nextCursor;
        if (!before) break;
      }
      if (!signal.aborted) {
        setItems([...new Map(all.map((item) => [item.id, item])).values()]);
        setHasMore(Boolean(before));
        setError(undefined);
      }
    } catch (failure) {
      if (!signal.aborted) setError(String(failure));
    } finally {
      if (!signal.aborted) { setLoaded(true); setLoading(false); }
    }
  }), [coordinator, entityId, kind, pages]);
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    void refresh();
    return () => { current.abort(); coordinator.reset(); };
  }, [coordinator, refresh]);
  useRealtime<ResourceRealtimeEvent>({
    resources: ["subagents"], targets: { [kind === "chat" ? "chatId" : "taskId"]: entityId },
    trackLastEvent: false,
    onSubscribed: () => { void refresh(); },
    onEvent: () => { void refresh(); },
    onError: (failure) => { setError(String(failure)); },
  });
  return { items, hasMore, loaded, loading, error, refresh, loadMore: () => setPages((count) => count + 1) };
}
