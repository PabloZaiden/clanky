import type { Chat } from "../types/chat";
import type { PersistedMessage, PersistedToolCall } from "../types/task";

type TranscriptEntry =
  | {
      type: "message";
      message: PersistedMessage;
      timestamp: string;
      sequence: number;
    }
  | {
      type: "tool";
      toolCall: PersistedToolCall;
      timestamp: string;
      sequence: number;
    };

export interface ChatTranscriptMarkdown {
  markdown: string;
  filename: string;
}

function sanitizeMarkdownHeading(value: string, fallback: string): string {
  return value.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim() || fallback;
}

function sanitizeFilenamePart(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return sanitized || "chat-transcript";
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return date.toISOString();
}

function getRoleLabel(role: PersistedMessage["role"]): string {
  return role === "assistant" ? "Assistant" : "User";
}

function getToolTitle(toolCall: PersistedToolCall): string {
  return sanitizeMarkdownHeading(toolCall.name, "tool");
}

function hasAttachments(message: PersistedMessage): boolean {
  return (message.attachments?.length ?? 0) > 0;
}

function hasMessageTranscriptContent(message: PersistedMessage): boolean {
  return message.content.trim().length > 0 || hasAttachments(message);
}

function formatMessageContent(message: PersistedMessage): string {
  const content = message.content.trim();
  if (content) {
    return content;
  }

  return "_Attachment sent. Attachment data is not included in this transcript._";
}

function buildEntries(chat: Chat): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let sequence = 0;

  for (const message of chat.state.messages) {
    if (!hasMessageTranscriptContent(message)) {
      continue;
    }
    entries.push({
      type: "message",
      message,
      timestamp: message.timestamp,
      sequence,
    });
    sequence += 1;
  }

  for (const toolCall of chat.state.toolCalls) {
    entries.push({
      type: "tool",
      toolCall,
      timestamp: toolCall.timestamp,
      sequence,
    });
    sequence += 1;
  }

  return entries.sort((left, right) => {
    const byTimestamp = left.timestamp.localeCompare(right.timestamp);
    return byTimestamp !== 0 ? byTimestamp : left.sequence - right.sequence;
  });
}

export function getChatTranscriptFilename(chat: Pick<Chat, "config">): string {
  return `${sanitizeFilenamePart(chat.config.name)}-${chat.config.id}.md`;
}

export function buildChatTranscriptMarkdown(chat: Chat): ChatTranscriptMarkdown | null {
  const entries = buildEntries(chat);
  if (entries.length === 0) {
    return null;
  }

  const lines: string[] = [
    `# ${sanitizeMarkdownHeading(chat.config.name, "Untitled chat")}`,
    "",
    `- Chat ID: \`${chat.config.id}\``,
    `- Workspace ID: \`${chat.config.workspaceId}\``,
    `- Exported at: ${new Date().toISOString()}`,
    "",
    "## Transcript",
  ];

  for (const entry of entries) {
    lines.push("");
    if (entry.type === "message") {
      lines.push(`### ${getRoleLabel(entry.message.role)} - ${formatTimestamp(entry.timestamp)}`);
      lines.push("");
      lines.push(formatMessageContent(entry.message));
      continue;
    }

    lines.push(`### Tool: ${getToolTitle(entry.toolCall)} - ${formatTimestamp(entry.timestamp)}`);
  }

  lines.push("");

  return {
    markdown: lines.join("\n"),
    filename: getChatTranscriptFilename(chat),
  };
}
