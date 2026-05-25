import { useCallback, useEffect, useLayoutEffect, useRef, type DependencyList } from "react";

const BOTTOM_THRESHOLD_PX = 48;

function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD_PX;
}

export function useStickyBottomScroll(dependencies: DependencyList) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isPinnedToBottomRef = useRef(true);
  const animationFrameRef = useRef<number | null>(null);
  const scheduledScrollTopRef = useRef(0);

  const cancelScheduledScroll = useCallback(() => {
    if (animationFrameRef.current === null) {
      return;
    }
    cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
  }, []);

  const scrollToBottomIfPinned = useCallback(() => {
    const currentContainer = containerRef.current;
    if (!currentContainer) {
      return;
    }
    const wasPinnedWhenScheduled = isPinnedToBottomRef.current || isNearBottom(currentContainer);
    const scheduledScrollTop = currentContainer.scrollTop;
    if (!wasPinnedWhenScheduled) {
      return;
    }
    isPinnedToBottomRef.current = true;
    scheduledScrollTopRef.current = scheduledScrollTop;

    cancelScheduledScroll();
    animationFrameRef.current = requestAnimationFrame(() => {
      animationFrameRef.current = null;
      const container = containerRef.current;
      if (!container) {
        return;
      }
      const stayedNearScheduledPosition = container.scrollTop >= scheduledScrollTop - BOTTOM_THRESHOLD_PX;
      if (!isPinnedToBottomRef.current && !isNearBottom(container) && !stayedNearScheduledPosition) {
        return;
      }

      isPinnedToBottomRef.current = true;
      container.scrollTop = container.scrollHeight;
      isPinnedToBottomRef.current = isNearBottom(container);
    });
  }, [cancelScheduledScroll]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const updatePinnedState = () => {
      const isCurrentlyNearBottom = isNearBottom(container);
      if (
        animationFrameRef.current !== null &&
        !isCurrentlyNearBottom &&
        Math.abs(container.scrollTop - scheduledScrollTopRef.current) > BOTTOM_THRESHOLD_PX
      ) {
        cancelScheduledScroll();
      }
      isPinnedToBottomRef.current = isCurrentlyNearBottom;
    };

    container.addEventListener("scroll", updatePinnedState, { passive: true });

    return () => {
      container.removeEventListener("scroll", updatePinnedState);
    };
  }, [cancelScheduledScroll]);

  useLayoutEffect(() => {
    scrollToBottomIfPinned();
    return cancelScheduledScroll;
  }, [...dependencies, scrollToBottomIfPinned, cancelScheduledScroll]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const content = contentRef.current;
    if (!content) {
      return;
    }

    const observer = new ResizeObserver(() => {
      scrollToBottomIfPinned();
    });
    observer.observe(content);

    return () => {
      observer.disconnect();
    };
  }, [scrollToBottomIfPinned]);

  useEffect(() => cancelScheduledScroll, [cancelScheduledScroll]);

  return { containerRef, contentRef };
}
