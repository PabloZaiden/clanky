import { MarkdownRenderer } from "../MarkdownRenderer";
import type { StreamingTextSegments } from "./types";

interface StreamingTextContentProps {
  content: string;
  streamingText: StreamingTextSegments | null;
  markdownEnabled: boolean;
  plainTextClassName: string;
  markdownClassName?: string;
  dimmed?: boolean;
}

export function StreamingTextContent({
  content,
  streamingText,
  markdownEnabled,
  plainTextClassName,
  markdownClassName,
  dimmed = false,
}: StreamingTextContentProps) {
  if (!content) {
    return null;
  }

  // Partial markdown re-rendering produces unstable structure while a response
  // is still being appended, so markdown content degrades to the stable full
  // render instead of trying to animate an arbitrary suffix fragment.
  if (markdownEnabled) {
    return (
      <MarkdownRenderer
        content={content}
        className={markdownClassName}
        dimmed={dimmed}
      />
    );
  }

  const hasAnimatedSuffix = Boolean(
    streamingText
    && streamingText.transition
    && streamingText.animatedSuffix.length > 0
  );
  const animatedStreamingText = hasAnimatedSuffix ? streamingText : null;

  return (
    <div className={plainTextClassName}>
      {animatedStreamingText ? (
        <>
          {animatedStreamingText.stablePrefix}
          <span
            key={animatedStreamingText.animationKey ?? undefined}
            data-stream-suffix="true"
            data-stream-transition={animatedStreamingText.transition ?? undefined}
            className={`streaming-text-suffix ${animatedStreamingText.transition === "enter" ? "animate-stream-reveal-enter" : "animate-stream-reveal-update"}`}
          >
            {animatedStreamingText.animatedSuffix}
          </span>
        </>
      ) : (
        content
      )}
    </div>
  );
}
