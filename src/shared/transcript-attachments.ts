import type { ChatTranscript } from "./chat-transcript";
import type { PersistedMessage } from "./task";
import type { MessageAttachment } from "./message-attachments";

export interface TranscriptAttachmentReference extends Omit<MessageAttachment, "data"> {
  resourceUrl: string;
}

export type TranscriptAttachment = MessageAttachment | TranscriptAttachmentReference;

export interface TranscriptMessage extends Omit<PersistedMessage, "attachments"> {
  attachments?: TranscriptAttachment[];
}

export function projectTranscriptMessage(message: TranscriptMessage, baseUrl: string): TranscriptMessage {
  if (!message.attachments?.length) return message;
  return {
    ...message,
    attachments: message.attachments.map((attachment) => {
      if (!("data" in attachment)) return attachment;
      const { data: _data, ...metadata } = attachment;
      return {
        ...metadata,
        resourceUrl: `${baseUrl}/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(attachment.id)}`,
      };
    }),
  };
}

export function projectTranscriptAttachments(transcript: ChatTranscript, baseUrl: string): ChatTranscript {
  return {
    ...transcript,
    messages: transcript.messages.map((message) => projectTranscriptMessage(message, baseUrl)),
  };
}
