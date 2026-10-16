import { memo, useEffect, useRef, useState } from "react";
import {
  VOICE_MAX_TEXT_CHARS,
  type MessageData,
  type VoiceTranslationLanguage,
} from "@/shared";
import type { BadgeVariant } from "../common";
import {
  getMessageAttachmentExtension,
  getMessageAttachmentKind,
  type MessageAttachment,
} from "@/shared/message-attachments";
import { ImageViewerModal } from "../ImageViewerModal";
import { StatusBadge } from "../common";
import { MarkdownRenderer } from "../MarkdownRenderer";
import type { TranscriptFileLinkContext } from "./types";
import { ActivitySpinner } from "./activity-spinner";
import { HarnessMessageAdmission } from "../harness-activity";
import { TranscriptTextContent } from "./transcript-file-links";
import { useStreamingTextReveal } from "./streaming-text";
import { formatTime } from "./utils";
import { getQuestionAnswerStatus } from "@/shared/harness-questions";
import {
  detectTrailingPromiseMarker,
  type PromiseMarkerOutcomeKind,
} from "../../utils/promise-markers";

interface MessageEntryProps {
  data: MessageData;
  showTimestamp: boolean;
  spacingClass: string;
  markdownEnabled: boolean;
  fileLinkContext?: TranscriptFileLinkContext;
  onReadAloud?: (messageId: string) => void;
  onTranslate: (
    sourceText: string,
    targetLanguage: VoiceTranslationLanguage,
    signal: AbortSignal,
  ) => Promise<string>;
  onTranslationError: (error: unknown) => void;
  playingReadAloudKey: string | null;
  readAloudStatus: "generating" | "playing" | null;
}

function getOutcomeBadgeVariant(kind: PromiseMarkerOutcomeKind): BadgeVariant {
  switch (kind) {
    case "complete":
      return "completed";
    case "plan_ready":
      return "plan_ready";
    case "blocked":
      return "warning";
    case "custom":
      return "default";
  }
}

export const MessageEntry = memo(function MessageEntry({
  data: msg,
  showTimestamp,
  spacingClass,
  markdownEnabled,
  fileLinkContext,
  onReadAloud,
  onTranslate,
  onTranslationError,
  playingReadAloudKey,
  readAloudStatus,
}: MessageEntryProps) {
  const isUser = msg.role === "user";
  const outcome = isUser || msg.question ? null : detectTrailingPromiseMarker(msg.content);
  const answerStatus = isUser && msg.question ? getQuestionAnswerStatus(msg.question.status) : undefined;
  const displayMessage = outcome ? { ...msg, content: outcome.content } : msg;
  const shouldRenderMarkdown = markdownEnabled && msg.role === "assistant";
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
  const sourceText = displayMessage.content;
  const [translation, setTranslation] = useState<{ source: string; text: string } | null>(null);
  const [translationRequest, setTranslationRequest] = useState<{
    source: string;
    language: VoiceTranslationLanguage;
  } | null>(null);
  const translationControllerRef = useRef<AbortController | null>(null);
  const currentTranslation = translation?.source === sourceText ? translation : null;
  const currentTranslationRequest = translationRequest?.source === sourceText
    ? translationRequest
    : null;
  const renderedContent = currentTranslation?.text ?? sourceText;
  const reveal = useStreamingTextReveal({
    message: msg,
    content: renderedContent,
    markdown: shouldRenderMarkdown,
    enabled: !isUser && !msg.question && !currentTranslation && !currentTranslationRequest,
  });
  const hasMessageText = sourceText.trim().length > 0;
  const canReadAloud = !isUser && Boolean(onReadAloud) && hasMessageText;
  const canTranslate = msg.role === "assistant"
    && hasMessageText
    && sourceText.trim().length <= VOICE_MAX_TEXT_CHARS;
  const isReadAloudActive = playingReadAloudKey === msg.id;
  const isGeneratingReadAloud = isReadAloudActive && readAloudStatus === "generating";
  const isTranslationBusy = currentTranslationRequest !== null;

  useEffect(() => () => {
    translationControllerRef.current?.abort();
    translationControllerRef.current = null;
  }, [msg.id, sourceText]);

  async function handleTranslate(targetLanguage: VoiceTranslationLanguage): Promise<void> {
    translationControllerRef.current?.abort();
    const controller = new AbortController();
    translationControllerRef.current = controller;
    const requestedSource = sourceText;
    setTranslationRequest({ source: requestedSource, language: targetLanguage });

    try {
      const translatedText = await onTranslate(
        requestedSource,
        targetLanguage,
        controller.signal,
      );
      if (
        controller.signal.aborted
        || translationControllerRef.current !== controller
      ) {
        return;
      }
      setTranslation({ source: requestedSource, text: translatedText });
    } catch (error) {
      if (
        !controller.signal.aborted
        && translationControllerRef.current === controller
      ) {
        onTranslationError(error);
      }
    } finally {
      if (translationControllerRef.current === controller) {
        translationControllerRef.current = null;
        setTranslationRequest(null);
      }
    }
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
        <div ref={reveal.ref} className={contentWidthClassName}>
          {!isUser && msg.question?.scope.kind === "child" && (
            <div className="text-xs text-gray-500 dark:text-gray-400">Subagent question</div>
          )}
          {isUser ? (
            <div
              className="rounded-[1.35rem] bg-gray-900 px-4 py-3 text-sm leading-7 text-white shadow-sm dark:bg-neutral-700 dark:text-gray-50"
              data-message-bubble="user"
            >
              <TranscriptTextContent
                content={displayMessage.content}
                className="whitespace-pre-wrap break-words text-white"
                fileLinkContext={fileLinkContext}
              />
            </div>
          ) : shouldRenderMarkdown ? (
            <MarkdownRenderer
              content={renderedContent}
              className="text-sm leading-7 text-gray-900 dark:text-white"
              fileLinkContext={fileLinkContext}
              revealFrom={reveal.from}
            />
          ) : (
            <TranscriptTextContent
              content={renderedContent}
              className="whitespace-pre-wrap break-words text-sm leading-7 text-gray-900 dark:text-white"
              fileLinkContext={fileLinkContext}
              revealFrom={reveal.from}
            />
          )}
          {answerStatus && (
            <div className="text-right text-xs text-gray-500 dark:text-gray-400" role="status">{answerStatus}</div>
          )}
          {isUser && <HarnessMessageAdmission inputId={msg.id} />}
          {outcome && (
            <div className="pt-1">
              <StatusBadge variant={getOutcomeBadgeVariant(outcome.kind)} size="sm">
                {outcome.label}
              </StatusBadge>
            </div>
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
          {(canReadAloud || canTranslate) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
              {canReadAloud && onReadAloud && (
                <button
                  type="button"
                  className={`inline-flex items-center gap-1 text-xs text-gray-500 underline-offset-2 hover:underline dark:text-gray-400 ${isGeneratingReadAloud ? "no-underline" : ""}`}
                  onClick={() => onReadAloud(msg.id)}
                  aria-label={
                    isGeneratingReadAloud
                      ? "Cancel audio generation"
                      : isReadAloudActive
                        ? "Stop reading summary"
                        : "Read response summary aloud"
                  }
                  aria-busy={isGeneratingReadAloud}
                >
                  {isGeneratingReadAloud ? (
                    <>
                      <ActivitySpinner className="h-3.5 w-3.5" />
                      <span>Generating audio…</span>
                    </>
                  ) : isReadAloudActive ? "Stop summary" : "Read summary"}
                </button>
              )}
              {canTranslate && (
                <>
                  <button
                    type="button"
                    className={`inline-flex items-center gap-1 text-xs text-gray-500 underline-offset-2 hover:underline disabled:cursor-wait disabled:opacity-60 dark:text-gray-400 ${currentTranslationRequest?.language === "en" ? "no-underline" : ""}`}
                    onClick={() => { void handleTranslate("en"); }}
                    disabled={isTranslationBusy}
                    aria-label="Translate to English"
                    aria-busy={currentTranslationRequest?.language === "en"}
                  >
                    {currentTranslationRequest?.language === "en" ? (
                      <>
                        <ActivitySpinner className="h-3.5 w-3.5" />
                        <span>Translating to English…</span>
                      </>
                    ) : "Translate to English"}
                  </button>
                  <button
                    type="button"
                    className={`inline-flex items-center gap-1 text-xs text-gray-500 underline-offset-2 hover:underline disabled:cursor-wait disabled:opacity-60 dark:text-gray-400 ${currentTranslationRequest?.language === "es" ? "no-underline" : ""}`}
                    onClick={() => { void handleTranslate("es"); }}
                    disabled={isTranslationBusy}
                    aria-label="Translate to Spanish"
                    aria-busy={currentTranslationRequest?.language === "es"}
                  >
                    {currentTranslationRequest?.language === "es" ? (
                      <>
                        <ActivitySpinner className="h-3.5 w-3.5" />
                        <span>Translating to Spanish…</span>
                      </>
                    ) : "Translate to Spanish"}
                  </button>
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
