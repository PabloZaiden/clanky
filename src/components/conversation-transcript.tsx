import type { ChatTranscript } from "@/shared";
import { useMarkdownPreference } from "../hooks/useMarkdownPreference";
import { ConversationViewer, type ConversationViewerProps } from "./log-viewer";

type Props = Omit<ConversationViewerProps, "messages" | "toolCalls" | "logs" | "markdownEnabled" | "hasOlderTranscript"> & {
  transcript: ChatTranscript;
};

export function ConversationTranscript({ transcript, ...props }: Props) {
  const { enabled: markdownEnabled } = useMarkdownPreference();
  return <ConversationViewer
    {...props}
    messages={transcript.messages}
    toolCalls={transcript.toolCalls}
    logs={transcript.logs}
    markdownEnabled={markdownEnabled}
    hasOlderTranscript={transcript.hasOlder}
  />;
}
