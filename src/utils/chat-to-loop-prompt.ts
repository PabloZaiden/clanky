import { EmptyChatTranscriptError } from "../types/chat";
import type { PersistedMessage } from "../types/loop";

const MAX_SPAWN_LOOP_NAME_LENGTH = 100;

function formatMessage(message: PersistedMessage): string | null {
  const content = message.content.trim();
  const attachmentCount = message.attachments?.length ?? 0;

  if (!content && attachmentCount === 0) {
    return null;
  }

  const parts = [
    `${message.role === "user" ? "User" : "Assistant"}:`,
    content || "[No text content]",
  ];

  if (attachmentCount > 0) {
    parts.push(`[${attachmentCount} image attachment${attachmentCount === 1 ? "" : "s"} referenced in the chat but not inlined here]`);
  }

  return parts.join("\n");
}

export function buildSpawnLoopName(chatName: string): string {
  const trimmed = chatName.trim() || "Untitled chat";
  const prefix = "Plan from ";
  const available = MAX_SPAWN_LOOP_NAME_LENGTH - prefix.length;
  return `${prefix}${trimmed.slice(0, available)}`;
}

export function buildSpawnLoopPrompt(chatName: string, messages: readonly PersistedMessage[]): string {
  const transcriptSections = messages
    .map((message) => formatMessage(message))
    .filter((message): message is string => message !== null);

  if (transcriptSections.length === 0) {
    throw new EmptyChatTranscriptError();
  }

  return [
    "You are creating a new Ralph plan loop from an existing chat conversation.",
    "Use the full transcript below as the source material for the work.",
    "Only the user and assistant messages are included here; tool calls and hidden reasoning are intentionally excluded.",
    "",
    `Chat title: ${chatName.trim() || "Untitled chat"}`,
    "",
    "What to do:",
    "1. Infer the final goal from the entire conversation, giving the latest user direction precedence when earlier turns conflict.",
    "2. Preserve concrete requirements, constraints, decisions, and relevant discoveries from earlier messages.",
    "3. Call out assumptions or open questions only when the conversation does not resolve them.",
    "4. Produce a plan that is ready for implementation by the spawned loop.",
    "",
    "Conversation transcript:",
    transcriptSections.join("\n\n"),
    "",
    "Create the implementation plan for the concrete work implied by this conversation.",
  ].join("\n");
}
