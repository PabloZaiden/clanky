import { useState } from "react";
import type { MessageData } from "../../types";
import type { MessageImageAttachment } from "../../types/message-attachments";
import { ImageViewerModal } from "../ImageViewerModal";
import { StreamingTextContent } from "./streaming-text-content";
import { formatTime } from "./utils";

interface MessageEntryProps {
  data: MessageData;
  showTimestamp: boolean;
  spacingClass: string;
  markdownEnabled: boolean;
  showRoleLabel: boolean;
}

export function MessageEntry({
  data: msg,
  showTimestamp,
  spacingClass,
  markdownEnabled,
  showRoleLabel,
}: MessageEntryProps) {
  const isUser = msg.role === "user";
  const shouldRenderMarkdown = markdownEnabled && msg.role === "assistant";
  const roleLabel = msg.role === "assistant" ? "Assistant" : "You";
  const [selectedAttachment, setSelectedAttachment] = useState<MessageImageAttachment | null>(null);
  const selectedImage = selectedAttachment ? {
    src: `data:${selectedAttachment.mimeType};base64,${selectedAttachment.data}`,
    alt: selectedAttachment.filename,
    title: selectedAttachment.filename,
    description: `${Math.max(1, Math.round(selectedAttachment.size / 1024))} KB`,
  } : null;

  return (
    <div className={`group ${spacingClass}`} data-message-role={msg.role}>
      {showTimestamp && (
        <time
          className={`mb-1 block text-[11px] text-gray-500 ${isUser ? "text-right pr-1" : ""}`}
          dateTime={msg.timestamp}
        >
          {formatTime(msg.timestamp)}
        </time>
      )}
      <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
        <div className="min-w-0 max-w-[min(85%,48rem)] space-y-2">
          {showRoleLabel && (
            <div className={`text-[11px] uppercase tracking-[0.2em] text-gray-500 ${isUser ? "text-right" : ""}`}>
            {roleLabel}
            </div>
          )}
          {isUser ? (
            <div className="rounded-[1.35rem] bg-[#2b2b2b] px-4 py-3 text-sm leading-7 text-white shadow-sm">
              <StreamingTextContent
                content={msg.content}
                markdownEnabled={false}
                plainTextClassName="whitespace-pre-wrap break-words text-white"
              />
            </div>
          ) : shouldRenderMarkdown ? (
            <StreamingTextContent
              content={msg.content}
              markdownEnabled={true}
              markdownClassName="text-sm leading-7 text-white"
              plainTextClassName="text-sm leading-7 whitespace-pre-wrap break-words text-white"
            />
          ) : (
            <StreamingTextContent
              content={msg.content}
              markdownEnabled={false}
              plainTextClassName="whitespace-pre-wrap break-words text-sm leading-7 text-white"
            />
          )}
          {msg.attachments && msg.attachments.length > 0 && (
            <div className={`flex flex-wrap gap-2 ${isUser ? "justify-end" : "justify-start"}`}>
              {msg.attachments.map((attachment) => (
                <button
                  key={attachment.id}
                  type="button"
                  onClick={() => setSelectedAttachment(attachment)}
                  className="rounded-xl border border-white/10 bg-black/20 p-1 text-left hover:border-white/20 focus:outline-none focus:ring-2 focus:ring-gray-400"
                  aria-label={`View ${attachment.filename}`}
                >
                  <img
                    src={`data:${attachment.mimeType};base64,${attachment.data}`}
                    alt={attachment.filename}
                    className="h-20 w-20 rounded-lg object-cover"
                  />
                </button>
              ))}
            </div>
          )}
          <ImageViewerModal image={selectedImage} onClose={() => setSelectedAttachment(null)} />
        </div>
      </div>
    </div>
  );
}
