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

function sanitizeMarkdownHeading(value: string): string {
  return value.replace(/\s+/g, " ").trim() || "Untitled chat";
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
  return toolCall.name.trim() || "tool";
}

function buildEntries(chat: Chat): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let sequence = 0;

  for (const message of chat.state.messages) {
    if (!message.content.trim()) {
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
    `# ${sanitizeMarkdownHeading(chat.config.name)}`,
    "",
    `- Chat ID: \`${chat.config.id}\``,
    `- Workspace ID: \`${chat.config.workspaceId}\``,
    `- Directory: \`${chat.config.directory}\``,
    `- Exported at: ${new Date().toISOString()}`,
    "",
    "## Transcript",
  ];

  for (const entry of entries) {
    lines.push("");
    if (entry.type === "message") {
      lines.push(`### ${getRoleLabel(entry.message.role)} - ${formatTimestamp(entry.timestamp)}`);
      lines.push("");
      lines.push(entry.message.content.trim());
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
