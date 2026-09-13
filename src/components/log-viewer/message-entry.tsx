import { memo, useState } from "react";
import type { MessageData } from "@/shared";
import {
  getMessageAttachmentExtension,
  getMessageAttachmentKind,
  type MessageAttachment,
} from "@/shared/message-attachments";
import { ImageViewerModal } from "../ImageViewerModal";
import { MarkdownRenderer } from "../MarkdownRenderer";
import type { TranscriptFileLinkContext } from "./types";
import { ActivitySpinner } from "./activity-spinner";
import { TranscriptTextContent } from "./transcript-file-links";
import { formatTime } from "./utils";

interface MessageEntryProps {
  data: MessageData;
  showTimestamp: boolean;
  spacingClass: string;
  markdownEnabled: boolean;
  showRoleLabel: boolean;
  fileLinkContext?: TranscriptFileLinkContext;
  onReadAloud?: (message: MessageData, mode: "full" | "summary") => void;
  readAloudSummaryEnabled: boolean;
  playingReadAloudKey: string | null;
  readAloudStatus: "generating" | "playing" | null;
  readAloudDisabled: boolean;
}

export const MessageEntry = memo(function MessageEntry({
  data: msg,
  showTimestamp,
  spacingClass,
  markdownEnabled,
  showRoleLabel,
  fileLinkContext,
  onReadAloud,
  readAloudSummaryEnabled,
  playingReadAloudKey,
  readAloudStatus,
  readAloudDisabled,
}: MessageEntryProps) {
  const isUser = msg.role === "user";
  const shouldRenderMarkdown = markdownEnabled && msg.role === "assistant";
  const roleLabel = msg.role === "assistant" ? "Assistant" : "You";
  const contentWidthClassName = isUser
    ? "min-w-0 max-w-[min(88%,64rem)] space-y-2"
    : "min-w-0 w-full space-y-2";
  const [selectedAttachment, setSelectedAttachment] = useState<MessageAttachment | null>(null);
  const selectedImage = selectedAttachment && getMessageAttachmentKind(selectedAttachment) === "image" ? {
    src: `data:${selectedAttachment.mimeType};base64,${selectedAttachment.data}`,
    alt: selectedAttachment.filename,
    title: selectedAttachment.filename,
    description: `${Math.max(1, Math.round(selectedAttachment.size / 1024))} KB`,
  } : null;
  const activeReadAloudMode = playingReadAloudKey === `${msg.id}:full`
    ? "full"
    : playingReadAloudKey === `${msg.id}:summary`
      ? "summary"
      : null;
  const generatingReadAloudMode = readAloudStatus === "generating"
    ? activeReadAloudMode
    : null;

  function renderReadAloudAction(
    mode: "full" | "summary",
    idleLabel: string,
    activeLabel: string,
    idleAriaLabel: string,
    activeAriaLabel: string,
  ) {
    const isActive = playingReadAloudKey === `${msg.id}:${mode}`;
    const isGenerating = isActive && readAloudStatus === "generating";
    return (
      <button
        type="button"
        className={`inline-flex items-center gap-1 text-xs text-gray-500 underline-offset-2 hover:underline dark:text-gray-400 ${isGenerating ? "no-underline" : ""}`}
        onClick={() => onReadAloud?.(msg, mode)}
        aria-label={isGenerating ? "Cancel audio generation" : isActive ? activeAriaLabel : idleAriaLabel}
        aria-busy={isGenerating}
      >
        {isGenerating ? (
          <>
            <ActivitySpinner className="h-3.5 w-3.5" />
            <span>Generating audio…</span>
          </>
        ) : isActive ? activeLabel : idleLabel}
      </button>
    );
  }

  return (
    <div className={`group ${spacingClass}`.trim()} data-message-role={msg.role}>
      {showTimestamp && (
        <time
          className={`mb-1 block text-[11px] text-gray-500 ${isUser ? "text-right pr-1" : ""}`}
          dateTime={msg.timestamp}
        >
          {formatTime(msg.timestamp)}
        </time>
      )}
      <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
        <div className={contentWidthClassName}>
          {showRoleLabel && (
            <div className={`text-[11px] uppercase tracking-[0.2em] text-gray-500 ${isUser ? "text-right" : ""}`}>
            {roleLabel}
            </div>
          )}
          {isUser ? (
            <div
              className="rounded-[1.35rem] bg-gray-900 px-4 py-3 text-sm leading-7 text-white shadow-sm dark:bg-neutral-700 dark:text-gray-50"
              data-message-bubble="user"
            >
              <TranscriptTextContent
                content={msg.content}
                className="whitespace-pre-wrap break-words text-white"
                fileLinkContext={fileLinkContext}
              />
            </div>
          ) : shouldRenderMarkdown ? (
            <MarkdownRenderer
              content={msg.content}
              className="text-sm leading-7 text-gray-900 dark:text-white"
              fileLinkContext={fileLinkContext}
            />
          ) : (
            <TranscriptTextContent
              content={msg.content}
              className="whitespace-pre-wrap break-words text-sm leading-7 text-gray-900 dark:text-white"
              fileLinkContext={fileLinkContext}
            />
          )}
          {msg.attachments && msg.attachments.length > 0 && (
            <div className={`flex flex-wrap gap-2 ${isUser ? "justify-end" : "justify-start"}`}>
              {msg.attachments.map((attachment) => (
                getMessageAttachmentKind(attachment) === "image" ? (
                  <button
                    key={attachment.id}
                    type="button"
                    onClick={() => setSelectedAttachment(attachment)}
                    className="rounded-xl border border-gray-200 bg-white/80 p-1 text-left hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-400 dark:border-white/10 dark:bg-black/20 dark:hover:border-white/20"
                    aria-label={`View ${attachment.filename}`}
                  >
                    <img
                      src={`data:${attachment.mimeType};base64,${attachment.data}`}
                      alt={attachment.filename}
                      className="h-20 w-20 rounded-lg object-cover"
                    />
                  </button>
                ) : (
                  <div
                    key={attachment.id}
                    className="flex max-w-56 min-w-0 items-center gap-2 rounded-xl border border-gray-200 bg-white/80 px-3 py-2 dark:border-white/10 dark:bg-black/20"
                    title={attachment.filename}
                  >
                    <span
                      aria-hidden="true"
                      className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded bg-gray-200 text-[10px] font-semibold text-gray-600 dark:bg-neutral-700 dark:text-gray-300"
                    >
                      {getMessageAttachmentExtension(attachment.filename).replace(".", "").toUpperCase() || "FILE"}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-xs text-gray-700 dark:text-gray-200">
                        {attachment.filename}
                      </span>
                      <span className="block text-[11px] text-gray-500 dark:text-gray-400">
                        {Math.max(1, Math.round(attachment.size / 1024))} KB
                      </span>
                    </span>
                  </div>
                )
              ))}
            </div>
          )}
          {!isUser && onReadAloud && msg.content.trim() && !readAloudDisabled && (
            <div className="flex flex-wrap gap-2 pt-1">
              {generatingReadAloudMode ? (
                renderReadAloudAction(
                  generatingReadAloudMode,
                  generatingReadAloudMode === "summary" ? "Read summary" : "Read aloud",
                  generatingReadAloudMode === "summary" ? "Stop summary" : "Stop reading",
                  generatingReadAloudMode === "summary"
                    ? "Read response summary aloud"
                    : "Read response aloud",
                  generatingReadAloudMode === "summary"
                    ? "Stop reading summary"
                    : "Stop reading response",
                )
              ) : (
                <>
                  {renderReadAloudAction(
                    "full",
                    "Read aloud",
                    "Stop reading",
                    "Read response aloud",
                    "Stop reading response",
                  )}
                  {readAloudSummaryEnabled ? renderReadAloudAction(
                    "summary",
                    "Read summary",
                    "Stop summary",
                    "Read response summary aloud",
                    "Stop reading summary",
                  ) : null}
                </>
              )}
            </div>
          )}
          <ImageViewerModal image={selectedImage} onClose={() => setSelectedAttachment(null)} />
        </div>
      </div>
    </div>
  );
});
