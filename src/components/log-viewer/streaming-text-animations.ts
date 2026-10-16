export const MAX_REVEAL_WORDS = 80;

interface WordReveal {
  element: Element;
  animation: Animation;
  delay: number;
}

export class StreamingTextAnimations {
  private readonly active = new Map<number, WordReveal>();
  private reducedMotion: MediaQueryList | null = null;

  get firstOffset(): number | undefined {
    return this.active.size > 0 ? Math.min(...this.active.keys()) : undefined;
  }

  sync(container: HTMLElement, from: number): void {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (document.hidden || preference.matches) {
      this.clear();
      return;
    }
    const elements = new Map([...container.querySelectorAll("[data-stream-reveal]")]
      .map((element) => [Number(element.getAttribute("data-stream-reveal")), element]));

    for (const [offset, reveal] of this.active) {
      const element = elements.get(offset);
      if (element === reveal.element) continue;
      const currentTime = reveal.animation.currentTime;
      reveal.animation.onfinish = null;
      reveal.animation.cancel();
      if (element) {
        // Markdown reconciliation may replace a span; retain its original clock.
        reveal.element = element;
        reveal.animation = this.animate(offset, reveal, typeof currentTime === "number" ? currentTime : 0);
      } else {
        this.active.delete(offset);
      }
    }

    let index = 0;
    for (const [offset, element] of elements) {
      if (offset < from || this.active.has(offset)) continue;
      if (this.active.size >= MAX_REVEAL_WORDS) break;
      const reveal = {
        element,
        delay: Math.min(index++ * 8, 48),
      };
      this.active.set(offset, { ...reveal, animation: this.animate(offset, reveal) });
    }
    if (this.active.size > 0 && !this.reducedMotion) {
      this.reducedMotion = preference;
      preference.addEventListener("change", this.clear);
      document.addEventListener("visibilitychange", this.handleVisibility);
    } else if (this.active.size === 0) {
      this.removeListeners();
    }
  }

  clear = (): void => {
    for (const { animation } of this.active.values()) {
      animation.onfinish = null;
      animation.cancel();
    }
    this.active.clear();
    this.removeListeners();
  };

  private animate(offset: number, reveal: Omit<WordReveal, "animation">, currentTime = 0): Animation {
    const animation = reveal.element.animate(
      [
        { opacity: 0.35, filter: "blur(1px)" },
        { opacity: 1, filter: "blur(0px)" },
      ],
      {
        duration: 250,
        delay: reveal.delay,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "backwards",
      },
    );
    animation.currentTime = currentTime;
    animation.onfinish = () => {
      this.active.delete(offset);
      if (this.active.size === 0) this.removeListeners();
    };
    return animation;
  }

  private handleVisibility = (): void => {
    if (document.hidden) this.clear();
  };

  private removeListeners(): void {
    this.reducedMotion?.removeEventListener("change", this.clear);
    this.reducedMotion = null;
    document.removeEventListener("visibilitychange", this.handleVisibility);
  }
}
