import type { MessageData } from "../../types";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { formatTime } from "./utils";

interface MessageEntryProps {
  data: MessageData;
  showHeader: boolean;
  spacingClass: string;
  index: number;
  markdownEnabled: boolean;
  showRoleLabel: boolean;
}

export function MessageEntry({ data: msg, showHeader, spacingClass, index, markdownEnabled, showRoleLabel }: MessageEntryProps) {
  const shouldRenderMarkdown = markdownEnabled && msg.role === "assistant";
  const roleLabel = msg.role === "assistant" ? "Assistant" : "You";

  return (
    <div key={`msg-${msg.id}-${index}`} className={`group ${spacingClass}`}>
      {showHeader && (
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
          <div className="rounded bg-neutral-800 p-2 sm:p-3">
            <MarkdownRenderer content={msg.content} className="text-xs" />
          </div>
        ) : (
          <div className="whitespace-pre-wrap break-words">
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
