import type { PersistedMessage } from "../types/loop";

const MAX_SPAWN_LOOP_NAME_LENGTH = 100;
const MAX_TRANSCRIPT_CHARACTERS = 12_000;

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
  const formattedMessages = messages
    .map((message) => formatMessage(message))
    .filter((message): message is string => message !== null);

  if (formattedMessages.length === 0) {
    throw new Error("Chat transcript is empty. Send at least one message before spawning a loop.");
  }

  const selectedMessages: string[] = [];
  let usedCharacters = 0;

  for (let index = formattedMessages.length - 1; index >= 0; index -= 1) {
    const message = formattedMessages[index]!;
    const nextSize = usedCharacters + message.length;
    if (selectedMessages.length > 0 && nextSize > MAX_TRANSCRIPT_CHARACTERS) {
      break;
    }

    selectedMessages.unshift(message);
    usedCharacters = nextSize;
  }

  const omittedCount = formattedMessages.length - selectedMessages.length;
  const transcriptSections = [
    omittedCount > 0
      ? `Note: ${omittedCount} earlier message${omittedCount === 1 ? "" : "s"} were omitted to keep the spawned loop prompt focused on the latest context.`
      : null,
    ...selectedMessages,
  ].filter((section): section is string => section !== null);

  return [
    "Use the following chat transcript as background context for this loop.",
    "Treat the most recent user intent, corrections, and constraints as authoritative if the conversation evolved over time.",
    "",
    `Chat title: ${chatName.trim() || "Untitled chat"}`,
    "",
    "Conversation transcript:",
    transcriptSections.join("\n\n"),
    "",
    "Create the plan for the concrete work implied by this conversation. When the conversation explored multiple directions, synthesize the final goal and call out any assumptions explicitly.",
  ].join("\n");
}
