import { useRef } from "react";
import type { PointerEvent } from "react";
import { ConversationViewer } from "../LogViewer";
import { useMarkdownPreference } from "../../hooks";
import type { ChatTranscriptProps } from "./types";

const VOICE_TRIPLE_TAP_WINDOW_MS = 750;

export function ChatTranscript({
  chat,
  transcript,
  lifecycleError,
  isActive,
  toolPathDisplayRoot,
  fileLinkContext,
  onLoadToolDetails,
  voiceInput,
  onStartVoice,
  onReadAloud,
  readAloudAvailable,
  readAloudSummaryAvailable,
  playingReadAloudKey,
  readAloudStatus,
}: ChatTranscriptProps) {
  const { enabled: markdownEnabled } = useMarkdownPreference();
  const tapCountRef = useRef(0);
  const lastTapAtRef = useRef(0);

  function resetTapSequence(): void {
    tapCountRef.current = 0;
    lastTapAtRef.current = 0;
  }

  function handleTranscriptPointerUp(event: PointerEvent<HTMLDivElement>): void {
    if (
      !voiceInput.available
      || (voiceInput.status !== "idle" && voiceInput.status !== "error")
      || !event.isPrimary
      || (event.pointerType === "mouse" && event.button !== 0)
    ) {
      return;
    }
    const target = event.target;
    if (
      target instanceof Element
      && target.closest("a,button,input,textarea,select,pre,code,[contenteditable='true']")
    ) {
      resetTapSequence();
      return;
    }
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

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
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
        markdownEnabled={markdownEnabled}
        showAssistantMessages
        showResponseLogs={false}
        toolPathDisplayRoot={toolPathDisplayRoot}
        fileLinkContext={fileLinkContext}
        emptyStateMessage="No messages yet"
        activeStateMessage="Thinking…"
        onReadAloud={readAloudAvailable ? onReadAloud : undefined}
        readAloudSummaryEnabled={readAloudSummaryAvailable}
        playingReadAloudKey={playingReadAloudKey}
        readAloudStatus={readAloudStatus}
      />
    </div>
  );
}
