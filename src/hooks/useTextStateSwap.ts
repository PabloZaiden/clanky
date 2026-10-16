import { useLayoutEffect, useRef } from "react";
import { useDocumentVisibility } from "./useDocumentVisibility";

export function useTextStateSwap(value: string) {
  const ref = useRef<HTMLSpanElement>(null);
  const visible = useDocumentVisibility();
  const previous = useRef({ value, visible });

  useLayoutEffect(() => {
    const prior = previous.current;
    previous.current = { value, visible };
    const element = ref.current;
    if (
      prior.value === value || !prior.visible || !visible || !element
      || element.getClientRects().length === 0
      || getComputedStyle(element).visibility !== "visible"
    ) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reducedMotion.matches) return;
    let animation: Animation | null = element.animate(
      [
        { opacity: 0.45, transform: "translateY(3px)", filter: "blur(1px)" },
        { opacity: 1, transform: "translateY(0)", filter: "blur(0px)" },
      ],
      {
        id: "clanky-text-state-swap",
        duration: 150,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    );
    const release = (): void => {
      reducedMotion.removeEventListener("change", cancel);
      if (animation) animation.onfinish = null;
      animation = null;
    };
    const cancel = (): void => {
      animation?.cancel();
      release();
    };
    animation.onfinish = release;
    reducedMotion.addEventListener("change", cancel);
    return cancel;
  }, [value, visible]);

  return ref;
}
