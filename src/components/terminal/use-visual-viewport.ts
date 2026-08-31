import type { CSSProperties } from "react";
import type { VisualViewportState } from "../common/use-visual-viewport";

export { useVisualViewport } from "../common/use-visual-viewport";
export type { VisualViewportState } from "../common/use-visual-viewport";

const MIN_BOTTOM_CLEARANCE_PX = 12;

function getViewportBottomClearancePx() {
  if (typeof window === "undefined") {
    return MIN_BOTTOM_CLEARANCE_PX;
  }
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--safe-area-inset-bottom");
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(parsed, MIN_BOTTOM_CLEARANCE_PX) : 0;
}

export function getFocusModeViewportStyle(
  enabled: boolean,
  viewport: VisualViewportState | null,
): CSSProperties | undefined {
  if (!enabled || !viewport) {
    return undefined;
  }

  const bottomClearance = getViewportBottomClearancePx();
  const style: CSSProperties = {
    height: `${Math.max(0, viewport.height - bottomClearance)}px`,
    overflow: "hidden",
  };
  if (viewport.offsetTop > 0) {
    style.transform = `translateY(${viewport.offsetTop}px)`;
  }
  return style;
}
