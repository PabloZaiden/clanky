/**
 * WebSocket event handling for real-time loop state updates.
 */

import type { Loop, LoopEvent } from "../../types";
import { isLoopEvent, useAppEvents } from "../useAppEvents";
import { useRefreshOnReconnect } from "../useRefreshOnReconnect";

interface UseLoopEventsOptions {
  refresh: () => Promise<void>;
  refreshLoop: (id: string) => Promise<void>;
  setLoops: React.Dispatch<React.SetStateAction<Loop[]>>;
}

export function useLoopEvents({ refresh, refreshLoop, setLoops }: UseLoopEventsOptions): void {
  function handleEvent(event: LoopEvent) {
    switch (event.type) {
      case "loop.created":
        // Refresh to get the full loop data
        refresh();
        break;

      case "loop.deleted":
        setLoops((prev) => prev.filter((loop) => loop.config.id !== event.loopId));
        break;

      case "loop.started":
      case "loop.stopped":
      case "loop.completed":
      case "loop.ssh_handoff":
      case "loop.merged":
      case "loop.accepted":
      case "loop.pushed":
      case "loop.discarded":
      case "loop.error":
      case "loop.iteration.start":
      case "loop.iteration.end":
      case "loop.plan.accepted":
      case "loop.plan.ready":
      case "loop.plan.feedback":
      case "loop.plan.discarded":
      case "loop.automatic_pr_flow.updated":
        // Refresh the specific loop to get updated state
        refreshLoop(event.loopId);
        break;
    }
  }

  const { status } = useAppEvents<LoopEvent>(handleEvent, isLoopEvent);

  useRefreshOnReconnect({
    status,
    onReconnect: refresh,
  });
}
