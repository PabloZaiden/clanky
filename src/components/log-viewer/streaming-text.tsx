import { useLayoutEffect, useRef, useState } from "react";
import type { Element, Root, RootContent } from "hast";
import type { MessageData } from "@/shared";
import { getStreamingTextStart } from "../../lib/streaming-text";
import { MAX_REVEAL_WORDS, StreamingTextAnimations } from "./streaming-text-animations";

const MAX_REVEAL_CHARACTERS = 1_024;

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
      reveal: index >= words.length - MAX_REVEAL_WORDS && /\S/.test(match[0]),
    })),
  ].filter((part) => part.text.length > 0);
}

export function renderRevealedText(content: string, offset: number, from: number) {
  if (offset + content.length <= from) return content;
  return splitRevealedText(content, offset, from).map((part) => (
    part.reveal
      ? <span key={part.start} data-stream-reveal={part.start}>{part.text}</span>
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
                properties: { "data-stream-reveal": part.start },
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
  const [animations] = useState(() => new StreamingTextAnimations());
  const previous = useRef<{ id: string; content: string; markdown: boolean; from: number } | null>(null);
  const prior = previous.current;
  const arrivalStart = enabled ? getStreamingTextStart(message) : undefined;
  const continuation = !prior || prior.id === message.id && prior.markdown === markdown
    && content.startsWith(prior.content);
  let newFrom = content.length;
  let from = content.length;
  if (enabled) {
    if (prior?.id === message.id && prior.markdown === markdown && prior.content === content) {
      // Keep this revision's spans stable during unrelated message UI updates.
      from = prior.from;
    } else if (continuation) {
      if (arrivalStart !== undefined) {
        newFrom = Math.max(arrivalStart, prior?.content.length ?? 0, content.length - MAX_REVEAL_CHARACTERS);
      }
      from = Math.min(newFrom, animations.firstOffset ?? newFrom);
    }
  }

  useLayoutEffect(() => () => animations.clear(), [animations, message.id, markdown, enabled]);

  useLayoutEffect(() => {
    previous.current = { id: message.id, content, markdown, from };
    if (!enabled || !continuation) animations.clear();
    if (enabled && ref.current) animations.sync(ref.current, newFrom);
  }, [animations, message.id, content, markdown, enabled, from, newFrom, continuation]);

  return { ref, from };
}
