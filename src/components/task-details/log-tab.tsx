import type {
  MessageData,
  TaskLogEntry,
  ToolCallData,
  ToolCallDisplayData,
} from "@/shared";
import { ConversationViewer } from "../log-viewer";
import type { TranscriptFileLinkContext } from "../log-viewer";

interface LogTabProps {
  messages: MessageData[];
  toolCalls: ToolCallDisplayData[];
  logs: TaskLogEntry[];
  markdownEnabled: boolean;
  isLogActive: boolean;
  toolPathDisplayRoot?: string;
  fileLinkContext?: TranscriptFileLinkContext;
  onLoadToolDetails?: (toolCallId: string) => Promise<ToolCallData | null>;
  hasOlderTranscript: boolean;
  onLoadMoreTranscript: () => Promise<void>;
  onLoadFullTranscript: () => Promise<void>;
  loadingTranscript: boolean;
}

export function LogTab({
  messages,
  toolCalls,
  logs,
  markdownEnabled,
  isLogActive,
  toolPathDisplayRoot,
  fileLinkContext,
  onLoadToolDetails,
  hasOlderTranscript,
  onLoadMoreTranscript,
  onLoadFullTranscript,
  loadingTranscript,
}: LogTabProps) {
  return (
    <ConversationViewer
      id="task-transcript"
      messages={messages}
      toolCalls={toolCalls}
      logs={logs}
      markdownEnabled={markdownEnabled}
      isActive={isLogActive}
      toolPathDisplayRoot={toolPathDisplayRoot}
      fileLinkContext={fileLinkContext}
      onLoadToolDetails={onLoadToolDetails}
      hasOlderTranscript={hasOlderTranscript}
      onLoadMoreTranscript={onLoadMoreTranscript}
      onLoadFullTranscript={onLoadFullTranscript}
      loadingTranscript={loadingTranscript}
    />
  );
}
