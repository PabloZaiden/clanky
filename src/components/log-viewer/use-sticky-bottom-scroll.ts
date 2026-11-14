import { useCallback, useEffect, useLayoutEffect, useRef, type DependencyList } from "react";
import { isDocumentVisible, useDocumentVisibility } from "../../hooks/useDocumentVisibility";

const BOTTOM_THRESHOLD_PX = 48;

function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD_PX;
}

export function useStickyBottomScroll(dependencies: DependencyList) {
  const visible = useDocumentVisibility();
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isPinnedToBottomRef = useRef(true);
  const wasVisibleRef = useRef(visible);
  const lastVisibleScrollTopRef = useRef(0);
  const animationFrameRef = useRef<number | null>(null);
  const scheduledScrollTopRef = useRef(0);
  const pendingPrependScrollRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  const cancelScheduledScroll = useCallback(() => {
    if (animationFrameRef.current === null) {
      return;
    }
    cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
  }, []);

  const scrollToBottomIfPinned = useCallback(() => {
    if (!wasVisibleRef.current || !isDocumentVisible()) {
      return;
    }
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
      if (!wasVisibleRef.current || !isDocumentVisible()) {
        return;
      }
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

  const preserveScrollPosition = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    pendingPrependScrollRef.current = {
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
    };
  }, []);

  const releaseBottomPin = useCallback(() => {
    isPinnedToBottomRef.current = false;
    if (containerRef.current) {
      lastVisibleScrollTopRef.current = containerRef.current.scrollTop;
    }
    cancelScheduledScroll();
  }, [cancelScheduledScroll]);

  const cancelPreservedScrollPosition = useCallback(() => {
    pendingPrependScrollRef.current = null;
  }, []);

  useLayoutEffect(() => {
    // WebKit can deliver a resumed scroll before its visibility event.
    if (!visible) {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let scrollHeight = container.scrollHeight;
    let clientHeight = container.clientHeight;
    let clientWidth = container.clientWidth;
    let scrollTop = container.scrollTop;
    const recordLayout = () => {
      scrollHeight = container.scrollHeight;
      clientHeight = container.clientHeight;
      clientWidth = container.clientWidth;
      scrollTop = container.scrollTop;
    };

    const updatePinnedState = () => {
      if (!isDocumentVisible()) {
        return;
      }
      lastVisibleScrollTopRef.current = container.scrollTop;
      const layoutChanged = scrollHeight !== container.scrollHeight
        || clientHeight !== container.clientHeight
        || clientWidth !== container.clientWidth;
      const scrollChanged = scrollTop !== container.scrollTop;
      recordLayout();
      // Reflow and viewport resizing can move the scroll without user input.
      if (layoutChanged || !scrollChanged) {
        if (isPinnedToBottomRef.current) {
          scrollToBottomIfPinned();
        }
        return;
      }
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
    const content = contentRef.current;
    const observer = typeof ResizeObserver !== "undefined" && content
      ? new ResizeObserver(() => {
        if (isPinnedToBottomRef.current) {
          scrollToBottomIfPinned();
        }
        recordLayout();
      })
      : null;
    if (observer && content) {
      observer.observe(content);
      observer.observe(container);
    }

    return () => {
      container.removeEventListener("scroll", updatePinnedState);
      observer?.disconnect();
    };
  }, [visible, cancelScheduledScroll, scrollToBottomIfPinned]);

  useLayoutEffect(() => {
    const resuming = visible && !wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (!visible) {
      return cancelScheduledScroll;
    }
    const container = containerRef.current;
    if (!container) {
      return cancelScheduledScroll;
    }
    const pendingPrependScroll = pendingPrependScrollRef.current;
    if (pendingPrependScroll) {
      pendingPrependScrollRef.current = null;
      container.scrollTop = pendingPrependScroll.scrollTop
        + container.scrollHeight
        - pendingPrependScroll.scrollHeight;
      return cancelScheduledScroll;
    }
    if (resuming && !isPinnedToBottomRef.current) {
      if (container.scrollTop !== lastVisibleScrollTopRef.current) {
        container.scrollTop = lastVisibleScrollTopRef.current;
      }
      return cancelScheduledScroll;
    }
    scrollToBottomIfPinned();
    return cancelScheduledScroll;
  }, [...dependencies, visible, scrollToBottomIfPinned, cancelScheduledScroll]);

  useEffect(() => cancelScheduledScroll, [cancelScheduledScroll]);

  return {
    containerRef,
    contentRef,
    preserveScrollPosition,
    cancelPreservedScrollPosition,
    releaseBottomPin,
  };
}
