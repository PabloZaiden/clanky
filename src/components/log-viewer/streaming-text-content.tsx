import { MarkdownRenderer } from "../MarkdownRenderer";

interface StreamingTextContentProps {
  content: string;
  markdownEnabled: boolean;
  plainTextClassName: string;
  markdownClassName?: string;
  dimmed?: boolean;
}

export function StreamingTextContent({
  content,
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

  return (
    <div className={plainTextClassName} data-dimmed={dimmed ? "true" : "false"}>
      {content}
    </div>
  );
}
