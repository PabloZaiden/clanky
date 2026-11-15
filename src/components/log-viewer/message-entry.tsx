import { memo, useEffect, useRef, useState } from "react";
import {
  VOICE_MAX_TEXT_CHARS,
  VOICE_TRANSLATION_LANGUAGE_NAMES,
  type TranscriptMessage,
  type VoiceTranslationLanguage,
} from "@/shared";
import {
  getMessageAttachmentKind,
} from "@/shared/message-attachments";
import type { TranscriptFileLinkContext } from "./types";
import { ActivitySpinner } from "./activity-spinner";
import { HarnessMessageAdmission } from "../harness-activity";
import { FileAttachment } from "./file-attachment";
import { ImageAttachment } from "./image-attachment";
import { MessageBody } from "./message-body";
import { formatTime } from "./utils";
import { getQuestionAnswerStatus } from "@/shared/harness-questions";
import { getDemoStorage } from "../../client-sdk/demo/storage";

interface MessageEntryProps {
  data: TranscriptMessage;
  showTimestamp: boolean;
  showDate: boolean;
  spacingClass: string;
  markdownEnabled: boolean;
  fileLinkContext?: TranscriptFileLinkContext;
  onReadAloud?: (messageId: string) => void;
  translationLanguages: VoiceTranslationLanguage[];
  onTranslate: (
    sourceText: string,
    targetLanguage: VoiceTranslationLanguage,
    signal: AbortSignal,
  ) => Promise<string>;
  onTranslationError: (error: unknown) => void;
  playingReadAloudKey: string | null;
  readAloudStatus: "generating" | "playing" | null;
  onBeforeExpand: () => void;
}

export const MessageEntry = memo(function MessageEntry({
  data: msg,
  showTimestamp,
  showDate,
  spacingClass,
  markdownEnabled,
  fileLinkContext,
  onReadAloud,
  translationLanguages,
  onTranslate,
  onTranslationError,
  playingReadAloudKey,
  readAloudStatus,
  onBeforeExpand,
}: MessageEntryProps) {
  const isUser = msg.role === "user";
  const answerStatus = isUser && msg.question ? getQuestionAnswerStatus(msg.question.status) : undefined;
  const shouldRenderMarkdown = markdownEnabled && msg.role === "assistant";
  const contentWidthClassName = isUser
    ? "min-w-0 max-w-[min(88%,64rem)] space-y-2"
    : "min-w-0 w-full space-y-2";
  const sourceText = msg.content;
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
  const hasMessageText = sourceText.trim().length > 0;
  const demo = getDemoStorage() !== undefined;
  const canReadAloud = !demo && !isUser && Boolean(onReadAloud) && hasMessageText;
  const canTranslate = !demo && msg.role === "assistant"
    && translationLanguages.length > 0
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
          {formatTime(msg.timestamp, showDate)}
        </time>
      )}
      <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
        <div className={contentWidthClassName}>
          {!isUser && msg.question?.scope.kind === "child" && (
            <div className="text-xs text-gray-500 dark:text-gray-400">Subagent question</div>
          )}
          <MessageBody
            key={msg.id}
            message={msg}
            content={renderedContent}
            markdownEnabled={shouldRenderMarkdown}
            revealEnabled={!isUser && !msg.question && !currentTranslation && !currentTranslationRequest}
            fileLinkContext={fileLinkContext}
            onBeforeExpand={onBeforeExpand}
          />
          {answerStatus && (
            <div className="text-right text-xs text-gray-500 dark:text-gray-400" role="status">{answerStatus}</div>
          )}
          {isUser && <HarnessMessageAdmission inputId={msg.id} />}
          {msg.attachments && msg.attachments.length > 0 && (
            <div className={`flex flex-wrap gap-2 ${isUser ? "justify-end" : "justify-start"}`}>
              {msg.attachments.map((attachment) => (
                getMessageAttachmentKind(attachment) === "image" ? (
                  <ImageAttachment key={attachment.id} attachment={attachment} />
                ) : (
                  <FileAttachment key={attachment.id} attachment={attachment} />
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
              {canTranslate && translationLanguages.map((language) => (
                <button
                  key={language}
                  type="button"
                  className={`inline-flex items-center gap-1 text-xs text-gray-500 underline-offset-2 hover:underline disabled:cursor-wait disabled:opacity-60 dark:text-gray-400 ${currentTranslationRequest?.language === language ? "no-underline" : ""}`}
                  onClick={() => { void handleTranslate(language); }}
                  disabled={isTranslationBusy}
                  aria-label={`Translate to ${VOICE_TRANSLATION_LANGUAGE_NAMES[language]}`}
                  aria-busy={currentTranslationRequest?.language === language}
                >
                  {currentTranslationRequest?.language === language && <ActivitySpinner className="h-3.5 w-3.5" />}
                  <span>{VOICE_TRANSLATION_LANGUAGE_NAMES[language]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
