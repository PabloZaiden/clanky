import { useEffect, useRef, useSyncExternalStore } from "react";
import { notePerformanceContent, performancePresentationCycle, subscribePerformanceStats } from "./performance-stats";

export function usePerformanceContent<T>(
  screen: "home" | "chat",
  ready: boolean,
  content: T,
  getRevision: (content: T) => string,
): void {
  const cycle = useSyncExternalStore(subscribePerformanceStats, performancePresentationCycle, () => -1);
  const previous = useRef<string | undefined>(undefined);
  const pending = useRef<number | undefined>(undefined);
  const latest = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (cycle < 0 || !ready) {
      previous.current = undefined;
      latest.current = undefined;
      return;
    }
    if (document.hidden) return;
    latest.current = getRevision(content);
    if (pending.current !== undefined) return;
    // The second frame lets the committed React content reach a paint opportunity.
    pending.current = requestAnimationFrame(() => {
      pending.current = requestAnimationFrame(() => {
        pending.current = undefined;
        const revision = latest.current;
        if (document.hidden || revision === undefined) return;
        notePerformanceContent(screen, previous.current !== undefined && previous.current !== revision);
        previous.current = revision;
      });
    });
  }, [screen, cycle, ready, content, getRevision]);

  useEffect(() => () => {
    if (pending.current !== undefined) cancelAnimationFrame(pending.current);
    pending.current = undefined;
  }, []);
}
