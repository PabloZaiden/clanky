import { useId, useState } from "react";
import type { MessageData } from "@/shared";
import { Button } from "../common";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { useStreamingTextReveal } from "./streaming-text";
import { TranscriptTextContent } from "./transcript-file-links";
import type { TranscriptFileLinkContext } from "./types";

const INITIAL_MESSAGE_CHARACTER_LIMIT = 100_000;

function previewMessage(content: string): string {
  let end = INITIAL_MESSAGE_CHARACTER_LIMIT;
  const last = content.charCodeAt(end - 1);
  const next = content.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    end--;
  }
  return content.slice(0, end);
}

export function MessageBody({
  message,
  content,
  markdownEnabled,
  revealEnabled,
  fileLinkContext,
  onBeforeExpand,
}: {
  message: MessageData;
  content: string;
  markdownEnabled: boolean;
  revealEnabled: boolean;
  fileLinkContext?: TranscriptFileLinkContext;
  onBeforeExpand: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const isUser = message.role === "user";
  const truncated = !expanded && content.length > INITIAL_MESSAGE_CHARACTER_LIMIT;
  const visibleContent = truncated ? previewMessage(content) : content;
  const reveal = useStreamingTextReveal({
    message,
    content: visibleContent,
    markdown: markdownEnabled,
    enabled: revealEnabled,
  });

  return (
    <div
      ref={reveal.ref}
      className={isUser
        ? "rounded-[1.35rem] bg-gray-900 px-4 py-3 text-lg leading-7 text-white shadow-sm dark:bg-neutral-700 dark:text-gray-50"
        : undefined}
      data-message-bubble={isUser ? "user" : undefined}
    >
      <div id={contentId}>
        {markdownEnabled ? (
          <MarkdownRenderer
            content={visibleContent}
            textSize="body"
            className="text-lg leading-7 text-gray-900 dark:text-white"
            fileLinkContext={fileLinkContext}
            revealFrom={reveal.from}
            isTruncated={truncated}
          />
        ) : (
          <TranscriptTextContent
            content={visibleContent}
            className={isUser
              ? "whitespace-pre-wrap break-words text-white"
              : "whitespace-pre-wrap break-words text-lg leading-7 text-gray-900 dark:text-white"}
            fileLinkContext={fileLinkContext}
            revealFrom={reveal.from}
          />
        )}
      </div>
      {truncated && (
        <div className={`mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs ${isUser ? "text-white/70" : "text-gray-500 dark:text-gray-400"}`}>
          <span>{visibleContent.length.toLocaleString()} / {content.length.toLocaleString()} characters</span>
          <Button
            type="button"
            variant="link"
            size="xs"
            className={isUser ? "text-white!" : undefined}
            aria-controls={contentId}
            aria-expanded={expanded}
            onClick={() => {
              onBeforeExpand();
              setExpanded(true);
            }}
          >
            Show full message
          </Button>
        </div>
      )}
    </div>
  );
}
