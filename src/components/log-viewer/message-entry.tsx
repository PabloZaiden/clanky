import type { MessageData } from "../../types";
import { MarkdownRenderer } from "../MarkdownRenderer";
import type { StreamingTransitionState } from "./types";
import { formatTime } from "./utils";

interface MessageEntryProps {
  data: MessageData;
  showTimestamp: boolean;
  spacingClass: string;
  markdownEnabled: boolean;
  showRoleLabel: boolean;
  streamingTransition: StreamingTransitionState;
}

function getStreamingTransitionClassName(streamingTransition: StreamingTransitionState): string {
  switch (streamingTransition) {
    case "enter":
      return "animate-soft-stream-enter";
    case "update":
      return "animate-soft-stream-update";
    default:
      return "";
  }
}

export function MessageEntry({
  data: msg,
  showTimestamp,
  spacingClass,
  markdownEnabled,
  showRoleLabel,
  streamingTransition,
}: MessageEntryProps) {
  const shouldRenderMarkdown = markdownEnabled && msg.role === "assistant";
  const roleLabel = msg.role === "assistant" ? "Assistant" : "You";
  const transitionClassName = getStreamingTransitionClassName(streamingTransition);
  const contentKey = msg.role === "assistant"
    ? `message-content-${msg.id}-${msg.content.length}`
    : `message-content-${msg.id}`;
  const transitionProps = streamingTransition
    ? { "data-stream-transition": streamingTransition }
    : {};

  return (
    <div className={`group ${spacingClass}`}>
      {showTimestamp && (
        <time className="text-gray-500 text-xs mb-0.5 block" dateTime={msg.timestamp}>
          {formatTime(msg.timestamp)}
        </time>
      )}
      <div className="min-w-0 space-y-2">
        {showRoleLabel && (
          <div className="text-[11px] uppercase tracking-wide text-gray-500">
            {roleLabel}
          </div>
        )}
        {shouldRenderMarkdown ? (
          <div
            key={contentKey}
            {...transitionProps}
            className={`rounded bg-neutral-800 p-2 sm:p-3 ${transitionClassName}`}
          >
            <MarkdownRenderer content={msg.content} className="text-xs" />
          </div>
        ) : (
          <div
            key={contentKey}
            {...transitionProps}
            className={`whitespace-pre-wrap break-words ${transitionClassName}`}
          >
            {msg.content}
          </div>
        )}
        {msg.attachments && msg.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {msg.attachments.map((attachment) => (
              <div
                key={attachment.id}
                className="rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-neutral-800 p-1"
              >
                <img
                  src={`data:${attachment.mimeType};base64,${attachment.data}`}
                  alt={attachment.filename}
                  className="h-20 w-20 rounded object-cover"
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
