import { useLayoutEffect, useRef } from "react";
import type { Element, Root, RootContent } from "hast";
import type { MessageData } from "@/shared";
import { getStreamingTextStart } from "../../lib/streaming-text";

const MAX_REVEAL_CHARACTERS = 1_024;
const MAX_REVEAL_WORDS = 80;

export function splitRevealedText(content: string, offset: number, from: number) {
  let boundary = Math.max(0, from - offset, content.length - MAX_REVEAL_CHARACTERS);
  // Keep words and file-path candidates intact across streamed token boundaries.
  while (boundary > 0 && boundary < content.length && !/\s/.test(content[boundary - 1]!)) {
    boundary += 1;
  }
  const prefix = content.slice(0, boundary);
  const words = [...content.slice(boundary).matchAll(/\S+\s*|\s+/g)];
  return [
    { text: prefix, start: offset, reveal: false },
    ...words.map((match, index) => ({
      text: match[0],
      start: offset + boundary + match.index,
      reveal: index < MAX_REVEAL_WORDS && /\S/.test(match[0]),
    })),
  ].filter((part) => part.text.length > 0);
}

export function renderRevealedText(content: string, offset: number, from: number) {
  if (offset + content.length <= from) return content;
  return splitRevealedText(content, offset, from).map((part) => (
    part.reveal
      ? <span key={part.start} data-stream-reveal="">{part.text}</span>
      : part.text
  ));
}

export function rehypeStreamingText({ content, from }: { content: string; from: number }) {
  return (tree: Root): void => {
    function visit(parent: Root | Element): void {
      parent.children = parent.children.flatMap((node): RootContent[] => {
        if (node.type === "element") {
          if (!["pre", "code", "table", "a"].includes(node.tagName)) visit(node);
          return [node];
        }
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (
          node.type !== "text" || start === undefined || end === undefined
          || end <= from || content.slice(start, end) !== node.value
        ) return [node];
        return splitRevealedText(node.value, start, from).map((part): RootContent => (
          part.reveal
            ? {
                type: "element",
                tagName: "span",
                properties: { "data-stream-reveal": "" },
                children: [{ type: "text", value: part.text }],
              }
            : { type: "text", value: part.text }
        ));
      });
    }
    visit(tree);
  };
}

export function useStreamingTextReveal({
  message,
  content,
  markdown,
  enabled,
}: {
  message: MessageData;
  content: string;
  markdown: boolean;
  enabled: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef<{ id: string; content: string; markdown: boolean } | null>(null);
  const prior = previous.current;
  const arrivalStart = enabled ? getStreamingTextStart(message) : undefined;
  const from = arrivalStart !== undefined
    && (!prior || prior.id === message.id && prior.markdown === markdown
      && content.startsWith(prior.content))
    ? Math.max(arrivalStart, prior?.content.length ?? 0, content.length - MAX_REVEAL_CHARACTERS)
    : content.length;

  useLayoutEffect(() => {
    previous.current = { id: message.id, content, markdown };
    if (
      !ref.current || from >= content.length || document.visibilityState === "hidden"
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) return;
    const animations = new Set([...ref.current.querySelectorAll("[data-stream-reveal]")]
      .slice(0, MAX_REVEAL_WORDS)
      .map((element, index) => element.animate(
        [
          { opacity: 0.35, filter: "blur(1px)" },
          { opacity: 1, filter: "blur(0px)" },
        ],
        {
          duration: 250,
          delay: Math.min(index * 8, 48),
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          fill: "backwards",
        },
      )));
    if (animations.size === 0) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const removeListeners = (): void => {
      reducedMotion.removeEventListener("change", cancel);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
    const cancel = (): void => {
      removeListeners();
      animations.forEach((animation) => animation.cancel());
      animations.clear();
    };
    const handleVisibility = (): void => {
      if (document.visibilityState === "hidden") cancel();
    };
    reducedMotion.addEventListener("change", cancel);
    document.addEventListener("visibilitychange", handleVisibility);
    animations.forEach((animation) => animation.addEventListener("finish", () => {
      animations.delete(animation);
      if (animations.size === 0) removeListeners();
    }, { once: true }));
    return cancel;
  }, [message.id, content, markdown]);

  return { ref, from };
}
