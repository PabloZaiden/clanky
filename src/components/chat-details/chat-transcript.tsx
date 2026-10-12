import { useEffect, useRef } from "react";
import type { PointerEvent } from "react";
import { isQuestionOpen } from "@/shared/harness-questions";
import { ConversationViewer } from "../log-viewer";
import { useMarkdownPreference } from "../../hooks";
import type { ChatTranscriptProps } from "./types";
import { ChatQuestions } from "./chat-questions";

const VOICE_TRIPLE_TAP_WINDOW_MS = 750;
const VOICE_TAP_MOVE_THRESHOLD_PX = 10;

export function ChatTranscript({
  chat,
  transcript,
  lifecycleError,
  isActive,
  toolPathDisplayRoot,
  fileLinkContext,
  onLoadToolDetails,
  onLoadMoreTranscript,
  onLoadFullTranscript,
  loadingTranscript,
  onChatSnapshot,
  dismissedExpiredQuestionRequestId,
  onQuestionAnswerFocusChange,
  voiceInput,
  onStartVoice,
  onReadAloud,
  readAloudAvailable,
  playingReadAloudKey,
  readAloudStatus,
}: ChatTranscriptProps) {
  const { enabled: markdownEnabled } = useMarkdownPreference();
  const tapCountRef = useRef(0);
  const lastTapAtRef = useRef(0);
  const pointerDownRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
  } | null>(null);

  function resetTapSequence(): void {
    tapCountRef.current = 0;
    lastTapAtRef.current = 0;
    pointerDownRef.current = null;
  }

  function isVoiceInputReady(): boolean {
    return (
      voiceInput.available
      && (voiceInput.status === "idle" || voiceInput.status === "error")
    );
  }

  function isIgnoredTranscriptTarget(target: EventTarget | null): boolean {
    return (
      target instanceof Element
      && Boolean(target.closest("a,button,input,textarea,select,pre,code,[contenteditable='true']"))
    );
  }

  function isAcceptedTapPointer(event: PointerEvent<HTMLDivElement>): boolean {
    if (
      !isVoiceInputReady()
      || !event.isPrimary
      || (event.pointerType === "mouse" && event.button !== 0)
    ) {
      return false;
    }
    return !isIgnoredTranscriptTarget(event.target);
  }

  function hasPointerMoved(
    pointer: { clientX: number; clientY: number },
    event: PointerEvent<HTMLDivElement>,
  ): boolean {
    return Math.hypot(
      event.clientX - pointer.clientX,
      event.clientY - pointer.clientY,
    ) > VOICE_TAP_MOVE_THRESHOLD_PX;
  }

  function handleTranscriptPointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (pointerDownRef.current) {
      resetTapSequence();
    }
    if (!isAcceptedTapPointer(event)) {
      resetTapSequence();
      return;
    }
    pointerDownRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    };
  }

  function handleTranscriptPointerMove(event: PointerEvent<HTMLDivElement>): void {
    const pointerDown = pointerDownRef.current;
    if (pointerDown?.pointerId === event.pointerId && hasPointerMoved(pointerDown, event)) {
      resetTapSequence();
    }
  }

  function handleTranscriptPointerUp(event: PointerEvent<HTMLDivElement>): void {
    const pointerDown = pointerDownRef.current;
    if (
      !pointerDown
      || pointerDown.pointerId !== event.pointerId
      || !isAcceptedTapPointer(event)
      || hasPointerMoved(pointerDown, event)
    ) {
      resetTapSequence();
      return;
    }
    pointerDownRef.current = null;
    const now = performance.now();
    if (now - lastTapAtRef.current > VOICE_TRIPLE_TAP_WINDOW_MS) {
      tapCountRef.current = 0;
    }
    tapCountRef.current += 1;
    lastTapAtRef.current = now;
    if (tapCountRef.current === 3) {
      resetTapSequence();
      void onStartVoice();
    }
  }

  useEffect(() => {
    resetTapSequence();
  }, [voiceInput.available, voiceInput.status]);

  const activity = chat.state.harness?.activity;
  const blockingQuestions = (chat.state.harness?.questions ?? [])
    .filter((request) => request.blocking && isQuestionOpen(request));
  const blocksPrincipal = blockingQuestions.some((request) => request.scope.kind !== "child");
  const hasConfirmedHarnessWork = activity?.observation === "available"
    && (
      (activity.principalProcessing && !blocksPrincipal)
      || activity.activities.some((item) => item.status === "stopping"
        || item.status === "running" && !blockingQuestions.some(
          (request) => request.scope.kind === "child" && request.scope.activityId === item.id,
        ))
    );
  // The call that raised a blocking question can remain marked in progress while suspended.
  const hasActiveTranscriptWork = transcript.toolCalls.some(
    (toolCall) => toolCall.status === "pending" || toolCall.status === "running",
  ) && blockingQuestions.length === 0;
  const isWorking = isActive && (
    chat.state.status !== "waiting" || hasConfirmedHarnessWork || hasActiveTranscriptWork
  );

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onPointerDown={handleTranscriptPointerDown}
      onPointerMove={handleTranscriptPointerMove}
      onPointerUp={handleTranscriptPointerUp}
      onPointerCancel={resetTapSequence}
    >
      {lifecycleError && (
        <div className="mx-4 mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-300">
          {lifecycleError}
        </div>
      )}
      {chat.state.error && (
        <div className="mx-4 mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-300">
          {chat.state.error.message}
        </div>
      )}
      <ConversationViewer
        id="chat-transcript"
        messages={transcript.messages}
        toolCalls={transcript.toolCalls}
        logs={transcript.logs}
        onLoadToolDetails={onLoadToolDetails}
        isActive={isActive}
        isWorking={isWorking}
        markdownEnabled={markdownEnabled}
        toolPathDisplayRoot={toolPathDisplayRoot}
        fileLinkContext={fileLinkContext}
        hasOlderTranscript={transcript.hasOlder}
        onLoadMoreTranscript={onLoadMoreTranscript}
        onLoadFullTranscript={onLoadFullTranscript}
        loadingTranscript={loadingTranscript}
        onReadAloud={readAloudAvailable ? onReadAloud : undefined}
        playingReadAloudKey={playingReadAloudKey}
        readAloudStatus={readAloudStatus}
        scrollContentFooter={
          <ChatQuestions
            chatId={chat.config.id}
            requests={chat.state.harness?.questions ?? []}
            dismissedExpiredQuestionRequestId={dismissedExpiredQuestionRequestId}
            onChatSnapshot={onChatSnapshot}
            onAnswerInputFocusChange={onQuestionAnswerFocusChange}
          />
        }
      />
    </div>
  );
}
