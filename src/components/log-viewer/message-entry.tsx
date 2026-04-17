import { useState } from "react";
import type { MessageData } from "../../types";
import type { MessageImageAttachment } from "../../types/message-attachments";
import { ImageViewerModal } from "../ImageViewerModal";
import { MarkdownRenderer } from "../MarkdownRenderer";
import type { StreamingTransitionState } from "./types";
import { useStreamingTransitionClass } from "./use-streaming-transition";
import { formatTime } from "./utils";

interface MessageEntryProps {
  data: MessageData;
  showTimestamp: boolean;
  spacingClass: string;
  markdownEnabled: boolean;
  showRoleLabel: boolean;
  streamingTransition: StreamingTransitionState;
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
  const [selectedAttachment, setSelectedAttachment] = useState<MessageImageAttachment | null>(null);
  const selectedImage = selectedAttachment ? {
    src: `data:${selectedAttachment.mimeType};base64,${selectedAttachment.data}`,
    alt: selectedAttachment.filename,
    title: selectedAttachment.filename,
    description: `${Math.max(1, Math.round(selectedAttachment.size / 1024))} KB`,
  } : null;
  const transitionToken = msg.role === "assistant"
    ? `message-content-${msg.id}-${msg.content.length}`
    : null;
  const transitionClassName = useStreamingTransitionClass(streamingTransition, transitionToken);
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
            {...transitionProps}
            className={`rounded bg-neutral-800 p-2 sm:p-3 ${transitionClassName}`}
          >
            <MarkdownRenderer content={msg.content} className="text-xs" />
          </div>
        ) : (
          <div
            {...transitionProps}
            className={`whitespace-pre-wrap break-words ${transitionClassName}`}
          >
            {msg.content}
          </div>
        )}
        {msg.attachments && msg.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {msg.attachments.map((attachment) => (
              <button
                key={attachment.id}
                type="button"
                onClick={() => setSelectedAttachment(attachment)}
                className="rounded border border-gray-200 bg-gray-50 p-1 text-left hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-400 dark:border-gray-700 dark:bg-neutral-800 dark:hover:border-gray-600 dark:focus:ring-gray-500"
                aria-label={`View ${attachment.filename}`}
              >
                <img
                  src={`data:${attachment.mimeType};base64,${attachment.data}`}
                  alt={attachment.filename}
                  className="h-20 w-20 rounded object-cover"
                />
              </button>
            ))}
          </div>
        )}
        <ImageViewerModal image={selectedImage} onClose={() => setSelectedAttachment(null)} />
      </div>
    </div>
  );
}
