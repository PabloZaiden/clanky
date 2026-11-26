import { useContext, useEffect, useMemo, useRef } from "react";
import type { PointerEvent } from "react";
import { isQuestionOpen } from "@/shared/harness-questions";
import { ConversationTranscript } from "../conversation-transcript";
import type { ChatTranscriptProps } from "./types";
import { ChatQuestions } from "./chat-questions";
import { LiveVoiceContext } from "../../hooks/useLiveVoice";
import { useWorkspaceReadOnly } from "../../context/workspace-access-context";
import { ChatProviderLimitPanel } from "./chat-provider-limit-panel";

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
  onQuestionAnswerFocusChange,
  onReadAloud,
  readAloudAvailable,
  playingReadAloudKey,
  readAloudStatus,
}: ChatTranscriptProps) {
  const liveVoice = useContext(LiveVoiceContext);
  const readOnly = useWorkspaceReadOnly();
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
    return Boolean(
      !readOnly && liveVoice?.available
      && !liveVoice.busy
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
      void liveVoice?.start();
    }
  }

  useEffect(() => {
    resetTapSequence();
  }, [liveVoice?.available, liveVoice?.busy]);

  const activity = chat.state.harness?.activity;
  const questions = chat.state.harness?.questions;
  const { visibleTranscript, questionMessages } = useMemo(() => {
    const pendingIds = new Set(questions?.flatMap((request) =>
      isQuestionOpen(request) && request.transcript ? [request.transcript.questionMessageId] : []));
    const questionMessages = new Map(transcript.openQuestionMessages?.map((message) => [message.id, message]));
    if (!pendingIds.size) return { visibleTranscript: transcript, questionMessages };
    const messages = transcript.messages.filter((message) => {
      if (!pendingIds.has(message.id)) return true;
      questionMessages.set(message.id, message);
      return false;
    });
    return { visibleTranscript: { ...transcript, messages }, questionMessages };
  }, [questions, transcript]);
  const blockingQuestions = (questions ?? [])
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
  const baseSyncWarnings = chat.state.worktree?.group?.repositories.filter((repository) => repository.baseSyncWarning) ?? [];

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
      <ChatProviderLimitPanel chat={chat} onChatSnapshot={onChatSnapshot} />
      {baseSyncWarnings.length > 0 ? (
        <details className="mx-4 mt-3 min-w-0 shrink-0 rounded-md bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/40 dark:text-amber-200">
          <summary className="cursor-pointer">Original base branches not updated ({baseSyncWarnings.length})</summary>
          <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto break-words">
            {baseSyncWarnings.map(({ name, baseSyncWarning }) => (
              <li key={name}><strong>{name}:</strong> {baseSyncWarning}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {chat.state.error && (!chat.state.harness?.providerLimit
        || chat.state.status !== "blocked" && chat.state.harness.providerLimit.continuation?.status !== "paused") && (
        <div className="mx-4 mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-300">
          {chat.state.error.message}
        </div>
      )}
      <ConversationTranscript
        id="chat-transcript"
        transcript={visibleTranscript}
        onLoadToolDetails={onLoadToolDetails}
        isActive={isActive}
        isWorking={isWorking}
        toolPathDisplayRoot={toolPathDisplayRoot}
        fileLinkContext={fileLinkContext}
        onLoadMoreTranscript={onLoadMoreTranscript}
        onLoadFullTranscript={onLoadFullTranscript}
        loadingTranscript={loadingTranscript}
        onReadAloud={readAloudAvailable ? onReadAloud : undefined}
        playingReadAloudKey={playingReadAloudKey}
        readAloudStatus={readAloudStatus}
        scrollContentFooter={(renderMessage) => (
          <ChatQuestions
            chatId={chat.config.id}
            requests={questions ?? []}
            questionMessages={questionMessages}
            renderMessage={renderMessage}
            readOnly={readOnly}
            onChatSnapshot={onChatSnapshot}
            onAnswerInputFocusChange={onQuestionAnswerFocusChange}
          />
        )}
      />
    </div>
  );
}
