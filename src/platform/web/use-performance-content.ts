import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { notePerformanceContent, performancePresentationCycle, subscribePerformanceStats } from "./performance-stats";

export function usePerformanceContent<T>(
  screen: "home" | "chat",
  ready: boolean,
  content: T,
  getRevision: (content: T) => string | undefined,
  observe?: RefObject<HTMLElement | null>,
): void {
  const cycle = useSyncExternalStore(subscribePerformanceStats, performancePresentationCycle, () => -1);
  const previous = useRef<string | undefined>(undefined);
  const pending = useRef<number | undefined>(undefined);
  const latest = useRef({ content, getRevision });
  const schedule = useCallback(() => {
    if (document.hidden || pending.current !== undefined) return;
    // The second frame lets the committed React content reach a paint opportunity.
    pending.current = requestAnimationFrame(() => {
      pending.current = requestAnimationFrame(() => {
        pending.current = undefined;
        if (document.hidden) return;
        const current = latest.current;
        const revision = current.getRevision(current.content);
        if (revision === undefined) return;
        notePerformanceContent(screen, previous.current !== undefined && previous.current !== revision);
        previous.current = revision;
      });
    });
  }, [screen]);

  useEffect(() => {
    latest.current = { content, getRevision };
    if (cycle < 0 || !ready) {
      previous.current = undefined;
      return;
    }
    schedule();
  }, [cycle, ready, content, getRevision, schedule]);

  useEffect(() => {
    if (cycle < 0 || !ready) return;
    const element = observe?.current;
    const observer = element ? new MutationObserver(schedule) : undefined;
    if (element) observer?.observe(element, { subtree: true, childList: true, characterData: true, attributeFilter: ["datetime"] });
    return () => {
      observer?.disconnect();
      if (pending.current !== undefined) cancelAnimationFrame(pending.current);
      pending.current = undefined;
    };
  }, [cycle, ready, observe, schedule]);
}
