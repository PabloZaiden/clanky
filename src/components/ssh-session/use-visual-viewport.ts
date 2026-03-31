/**
 * Hook that tracks the visual viewport height, which shrinks when the
 * mobile on-screen keyboard is visible.  Returns `null` when the
 * VisualViewport API is unavailable or the hook is disabled.
 *
 * The returned object includes:
 * - `height` – the visual viewport height in CSS pixels
 * - `offsetTop` – how far the visual viewport is scrolled from the
 *   layout viewport top (iOS Safari shifts this when the keyboard opens)
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface VisualViewportState {
  /** Visual viewport height in CSS pixels. */
  height: number;
  /** Offset from layout viewport top (iOS keyboard scroll). */
  offsetTop: number;
}

export function getFocusModeViewportStyle(
  enabled: boolean,
  viewport: VisualViewportState | null,
): Record<string, string> | undefined {
  if (!enabled || !viewport) {
    return undefined;
  }

  const style: Record<string, string> = {
    height: `${viewport.height}px`,
    overflow: "hidden",
  };
  if (viewport.offsetTop > 0) {
    style["transform"] = `translateY(${viewport.offsetTop}px)`;
  }
  return style;
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
      return; // already scheduled
    }
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const vv = window.visualViewport;
      if (!vv) return;
      setState((prev) => {
        if (prev && prev.height === vv.height && prev.offsetTop === vv.offsetTop) {
          return prev; // no change — skip re-render
        }
        return { height: vv.height, offsetTop: vv.offsetTop };
      });
    });
  }, []);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!enabled || !vv) {
      setState(null);
      return;
    }

    // Sync immediately on enable
    setState({ height: vv.height, offsetTop: vv.offsetTop });

    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);

    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [enabled, sync]);

  return state;
}
