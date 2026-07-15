import { ConversationViewer } from "../LogViewer";
import { useMarkdownPreference } from "../../hooks";
import type { ChatTranscriptProps } from "./types";

export function ChatTranscript({
  chat,
  isActive,
  toolPathDisplayRoot,
  fileLinkContext,
}: ChatTranscriptProps) {
  const { enabled: markdownEnabled } = useMarkdownPreference();

  return (
    <>
      {chat.state.error && (
        <div className="mx-4 mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-300">
          {chat.state.error.message}
        </div>
      )}
      <ConversationViewer
        id="chat-transcript"
        messages={chat.state.messages}
        toolCalls={chat.state.toolCalls}
        logs={chat.state.logs}
        isActive={isActive}
        activeMessageId={chat.state.activeMessageId}
        markdownEnabled={markdownEnabled}
        showAssistantMessages
        showResponseLogs={false}
        toolPathDisplayRoot={toolPathDisplayRoot}
        fileLinkContext={fileLinkContext}
        emptyStateMessage="No messages yet"
        activeStateMessage="Thinking…"
      />
    </>
  );
}
