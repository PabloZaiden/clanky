import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";

const PRIVATE_ITEM_HOVER_DELAY_MS = 1_000;
const PRIVATE_ITEM_REVEAL_DURATION_MS = 2_000;
const PRIVATE_ITEM_REBLUR_DURATION_MS = 500;
const PRIVATE_ITEM_TRANSITION_BUFFER_MS = 50;

export type PrivateItemRevealPhase = "obscured" | "unblurring" | "revealed" | "reblurring";

export interface PrivateItemReveal {
  phase: PrivateItemRevealPhase;
  stateClassName: string;
  className: string;
  canActivate: boolean;
  onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: PointerEvent<HTMLElement>) => void;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function clearTimer(timer: { current: ReturnType<typeof setTimeout> | null }): void {
  if (timer.current !== null) {
    clearTimeout(timer.current);
    timer.current = null;
  }
}

export function usePrivateItemReveal(privateHidden: boolean): PrivateItemReveal {
  const [phase, setPhase] = useState<PrivateItemRevealPhase>("obscured");
  const phaseRef = useRef<PrivateItemRevealPhase>("obscured");
  const mouseInsideRef = useRef(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reblurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updatePhase = useCallback((nextPhase: PrivateItemRevealPhase) => {
    phaseRef.current = nextPhase;
    setPhase(nextPhase);
  }, []);

  const clearTimers = useCallback(() => {
    clearTimer(hoverTimerRef);
    clearTimer(revealTimerRef);
    clearTimer(reblurTimerRef);
  }, []);

  useEffect(() => {
    mouseInsideRef.current = false;
    clearTimers();
    updatePhase("obscured");
    return clearTimers;
  }, [clearTimers, privateHidden, updatePhase]);

  const onPointerEnter = useCallback((event: PointerEvent<HTMLElement>) => {
    if (!privateHidden || event.pointerType !== "mouse") {
      return;
    }

    mouseInsideRef.current = true;
    clearTimer(hoverTimerRef);
    if (phaseRef.current === "unblurring" || phaseRef.current === "revealed") {
      return;
    }

    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      if (!mouseInsideRef.current) {
        return;
      }

      if (prefersReducedMotion()) {
        updatePhase("revealed");
        return;
      }

      updatePhase("unblurring");
      revealTimerRef.current = setTimeout(() => {
        revealTimerRef.current = null;
        if (mouseInsideRef.current) {
          updatePhase("revealed");
        }
      }, PRIVATE_ITEM_REVEAL_DURATION_MS + PRIVATE_ITEM_TRANSITION_BUFFER_MS);
    }, PRIVATE_ITEM_HOVER_DELAY_MS);
  }, [privateHidden, updatePhase]);

  const onPointerLeave = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== "mouse") {
      return;
    }

    mouseInsideRef.current = false;
    clearTimer(hoverTimerRef);
    clearTimer(revealTimerRef);

    if (phaseRef.current === "unblurring" || phaseRef.current === "revealed") {
      if (prefersReducedMotion()) {
        updatePhase("obscured");
        return;
      }

      updatePhase("reblurring");
      reblurTimerRef.current = setTimeout(() => {
        reblurTimerRef.current = null;
        updatePhase("obscured");
      }, PRIVATE_ITEM_REBLUR_DURATION_MS);
    }
  }, [updatePhase]);

  const stateClassName = phase === "obscured"
    ? ""
    : `clanky-private-${phase}`;

  return {
    phase,
    stateClassName,
    className: privateHidden
      ? ["clanky-private-obscured", stateClassName].filter(Boolean).join(" ")
      : "",
    canActivate: !privateHidden || phase === "revealed",
    onPointerEnter,
    onPointerLeave,
  };
}
