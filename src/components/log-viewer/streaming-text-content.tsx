import { MarkdownRenderer } from "../MarkdownRenderer";
import type { TranscriptFileLinkContext } from "./types";
import { TranscriptTextContent } from "./transcript-file-links";

interface StreamingTextContentProps {
  content: string;
  markdownEnabled: boolean;
  plainTextClassName: string;
  markdownClassName?: string;
  dimmed?: boolean;
  fileLinkContext?: TranscriptFileLinkContext;
  deferMarkdown?: boolean;
}

export function StreamingTextContent({
  content,
  markdownEnabled,
  plainTextClassName,
  markdownClassName,
  dimmed = false,
  fileLinkContext,
  deferMarkdown = false,
}: StreamingTextContentProps) {
  if (!content) {
    return null;
  }

  // Partial markdown re-rendering produces unstable structure while a response
  // is still being appended, so markdown content degrades to the stable full
  // render instead of trying to animate an arbitrary suffix fragment.
  if (markdownEnabled && !deferMarkdown) {
    return (
      <MarkdownRenderer
        content={content}
        className={markdownClassName}
        dimmed={dimmed}
        fileLinkContext={fileLinkContext}
      />
    );
  }

  return <TranscriptTextContent content={content} className={plainTextClassName} dimmed={dimmed} fileLinkContext={fileLinkContext} />;
}
