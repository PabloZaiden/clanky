import { useCallback, useEffect, useLayoutEffect, useRef, type DependencyList } from "react";

const BOTTOM_THRESHOLD_PX = 24;

function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD_PX;
}

export function useStickyBottomScroll(dependencies: DependencyList) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isPinnedToBottomRef = useRef(true);
  const animationFrameRef = useRef<number | null>(null);

  const cancelScheduledScroll = useCallback(() => {
    if (animationFrameRef.current === null) {
      return;
    }
    cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
  }, []);

  const scrollToBottomIfPinned = useCallback(() => {
    const currentContainer = containerRef.current;
    if (!isPinnedToBottomRef.current && (!currentContainer || !isNearBottom(currentContainer))) {
      return;
    }
    isPinnedToBottomRef.current = true;

    cancelScheduledScroll();
    animationFrameRef.current = requestAnimationFrame(() => {
      animationFrameRef.current = null;
      const container = containerRef.current;
      if (!container) {
        return;
      }
      if (!isPinnedToBottomRef.current && !isNearBottom(container)) {
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
      isPinnedToBottomRef.current = isNearBottom(container);
    };

    container.addEventListener("scroll", updatePinnedState, { passive: true });

    return () => {
      container.removeEventListener("scroll", updatePinnedState);
    };
  }, []);

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
