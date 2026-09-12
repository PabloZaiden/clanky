import { ConversationViewer } from "../LogViewer";
import type { MouseEvent } from "react";
import { useMarkdownPreference } from "../../hooks";
import type { ChatTranscriptProps } from "./types";

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
}: ChatTranscriptProps) {
  const { enabled: markdownEnabled } = useMarkdownPreference();

  function handleTranscriptClick(event: MouseEvent<HTMLDivElement>): void {
    if (!voiceInput.available || event.detail !== 3) {
      return;
    }
    const target = event.target;
    if (
      target instanceof HTMLElement
      && target.closest("a,button,input,textarea,select,pre,code")
    ) {
      return;
    }
    void onStartVoice();
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" onClick={handleTranscriptClick}>
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
      />
    </div>
  );
}
