/**
 * Tracks visual viewport changes such as the mobile on-screen keyboard.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface VisualViewportState {
  /** Visual viewport height in CSS pixels. */
  height: number;
  /** Offset from the layout viewport top. */
  offsetTop: number;
}

const VIEWPORT_REDUCTION_TOLERANCE_PX = 1;

export function isVisualViewportReduced(
  viewport: VisualViewportState | null,
  layoutViewportHeight: number,
): boolean {
  return viewport !== null
    && viewport.height + VIEWPORT_REDUCTION_TOLERANCE_PX < layoutViewportHeight;
}

export function useVisualViewport(enabled: boolean): VisualViewportState | null {
  const [state, setState] = useState<VisualViewportState | null>(() => {
    if (!enabled || typeof window === "undefined" || !window.visualViewport) {
      return null;
    }
    return {
      height: window.visualViewport.height,
      offsetTop: window.visualViewport.offsetTop,
    };
  });

  const rafRef = useRef<number | null>(null);

  const sync = useCallback(() => {
    if (rafRef.current !== null) {
      return;
    }
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const viewport = window.visualViewport;
      if (!viewport) {
        return;
      }
      setState((previous) => {
        if (
          previous
          && previous.height === viewport.height
          && previous.offsetTop === viewport.offsetTop
        ) {
          return previous;
        }
        return {
          height: viewport.height,
          offsetTop: viewport.offsetTop,
        };
      });
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      setState(null);
      return;
    }

    const viewport = window.visualViewport;
    if (!enabled || !viewport) {
      setState(null);
      return;
    }

    setState({
      height: viewport.height,
      offsetTop: viewport.offsetTop,
    });

    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);

    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [enabled, sync]);

  return state;
}
