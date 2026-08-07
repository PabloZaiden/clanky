import type { Chat } from "@/shared/chat";
import type { PersistedMessage, PersistedToolCall } from "@/shared/task";
import { getToolMeta } from "../components/log-viewer/tool-inference";

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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
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
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function getRoleLabel(role: PersistedMessage["role"]): string {
  return role === "assistant" ? "Assistant" : "User";
}

function getToolTitle(toolCall: PersistedToolCall): string {
  return sanitizeMarkdownHeading(getToolMeta(toolCall).summary, "tool");
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
  return `${sanitizeFilenamePart(chat.config.name)}.md`;
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

    lines.push(`### ${getToolTitle(entry.toolCall)} - ${formatTimestamp(entry.timestamp)}`);
  }

  lines.push("");

  return {
    markdown: lines.join("\n"),
    filename: getChatTranscriptFilename(chat),
  };
}

export function buildChatTranscriptHtml(chat: Chat): string | null {
  const transcript = buildChatTranscriptMarkdown(chat);
  if (!transcript) {
    return null;
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>${escapeHtml(sanitizeMarkdownHeading(chat.config.name, "Chat transcript"))}</title>
    <style>
      :root {
        color-scheme: light;
      }

      html,
      body {
        min-height: 100%;
        margin: 0;
      }

      body {
        box-sizing: border-box;
        padding: 2rem;
        background: #fff;
        color: #111;
        font-family: system-ui, sans-serif;
      }

      main {
        width: 100%;
        max-width: 64rem;
        margin: 0 auto;
      }

      pre {
        margin: 0;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        font-size: 0.875rem;
        line-height: 1.5;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      @media print {
        @page {
          margin: 16mm;
        }

        body {
          padding: 0;
        }

        main {
          max-width: none;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <pre>${escapeHtml(transcript.markdown)}</pre>
    </main>
  </body>
</html>`;
}
