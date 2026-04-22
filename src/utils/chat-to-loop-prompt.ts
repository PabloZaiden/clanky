import { EmptyChatTranscriptError } from "../types/chat";
import type { PersistedMessage } from "../types/loop";

const MAX_SPAWN_LOOP_NAME_LENGTH = 100;
const MAX_SPAWN_LOOP_PROMPT_LENGTH = 32_000;
const MAX_COMPACT_MESSAGE_CONTENT_LENGTH = 280;

interface TranscriptMessageSection {
  role: PersistedMessage["role"];
  attachmentCount: number;
  full: string;
  compact: string;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function createAttachmentReferenceLine(attachmentCount: number): string | null {
  if (attachmentCount === 0) {
    return null;
  }

  return `[${attachmentCount} image attachment${attachmentCount === 1 ? "" : "s"} referenced in the chat but not inlined here]`;
}

function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }

  return `${content.slice(0, maxLength).trimEnd()}...`;
}

function formatMessage(message: PersistedMessage): TranscriptMessageSection | null {
  const content = message.content.trim();
  const attachmentCount = message.attachments?.length ?? 0;

  if (!content && attachmentCount === 0) {
    return null;
  }

  const roleLabel = message.role === "user" ? "User" : "Assistant";
  const attachmentReference = createAttachmentReferenceLine(attachmentCount);
  const fullParts = [
    `${roleLabel}:`,
    content || "[No text content]",
  ];

  if (attachmentReference) {
    fullParts.push(attachmentReference);
  }

  const compactParts = attachmentCount === 0 && !content
    ? fullParts
    : [
        `${roleLabel}:`,
        "[Earlier message compacted to stay within the spawned loop prompt budget.]",
        content ? truncateContent(content, MAX_COMPACT_MESSAGE_CONTENT_LENGTH) : "[No text content]",
      ];

  if (attachmentReference) {
    compactParts.push(attachmentReference);
  }

  return {
    role: message.role,
    attachmentCount,
    full: fullParts.join("\n"),
    compact: compactParts.join("\n"),
  };
}

function buildOmittedTranscriptSummary(
  omittedSections: readonly TranscriptMessageSection[],
): string {
  const userTurns = omittedSections.filter((section) => section.role === "user").length;
  const assistantTurns = omittedSections.length - userTurns;
  const attachmentCount = omittedSections.reduce(
    (total, section) => total + section.attachmentCount,
    0,
  );

  const summary = [
    "Earlier transcript summary:",
    `[${omittedSections.length} older ${pluralize(omittedSections.length, "message")} summarized to keep the spawned loop prompt within size limits.]`,
    `Included here: ${userTurns} user ${pluralize(userTurns, "turn")}, ${assistantTurns} assistant ${pluralize(assistantTurns, "turn")}${attachmentCount > 0 ? `, and ${attachmentCount} image attachment ${pluralize(attachmentCount, "reference")}` : ""}.`,
  ];

  return summary.join("\n");
}

function buildPrompt(chatTitle: string, transcriptSections: readonly string[]): string {
  return [
    "You are creating a new Ralph plan loop from an existing chat conversation.",
    "Use the transcript below as the source material for the work.",
    "Only the user and assistant messages are included here; tool calls and hidden reasoning are intentionally excluded.",
    "If older turns were compacted or summarized to stay within prompt-size safeguards, treat those markers as authoritative excerpts of the earlier conversation.",
    "",
    `Chat title: ${chatTitle}`,
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

export function buildSpawnLoopName(chatName: string): string {
  const trimmed = chatName.trim() || "Untitled chat";
  const prefix = "Plan from ";
  const available = MAX_SPAWN_LOOP_NAME_LENGTH - prefix.length;
  return `${prefix}${trimmed.slice(0, available)}`;
}

export function buildSpawnLoopPrompt(chatName: string, messages: readonly PersistedMessage[]): string {
  const formattedMessages = messages
    .map((message) => formatMessage(message))
    .filter((message): message is TranscriptMessageSection => message !== null);

  if (formattedMessages.length === 0) {
    throw new EmptyChatTranscriptError();
  }

  const chatTitle = chatName.trim() || "Untitled chat";
  const fullTranscriptSections = formattedMessages.map((message) => message.full);
  const fullPrompt = buildPrompt(chatTitle, fullTranscriptSections);

  if (fullPrompt.length <= MAX_SPAWN_LOOP_PROMPT_LENGTH) {
    return fullPrompt;
  }

  const compactTranscriptSections = [...fullTranscriptSections];

  for (let index = 0; index < formattedMessages.length; index += 1) {
    const message = formattedMessages[index];
    if (!message) {
      continue;
    }

    compactTranscriptSections[index] = message.compact;
    const compactPrompt = buildPrompt(chatTitle, compactTranscriptSections);
    if (compactPrompt.length <= MAX_SPAWN_LOOP_PROMPT_LENGTH) {
      return compactPrompt;
    }
  }

  for (let omittedCount = 1; omittedCount < formattedMessages.length; omittedCount += 1) {
    const summary = buildOmittedTranscriptSummary(formattedMessages.slice(0, omittedCount));
    const remainingSections = compactTranscriptSections.slice(omittedCount);
    const candidatePrompt = buildPrompt(chatTitle, [summary, ...remainingSections]);

    if (candidatePrompt.length <= MAX_SPAWN_LOOP_PROMPT_LENGTH) {
      return candidatePrompt;
    }
  }

  const latestMessage = formattedMessages.at(-1);
  if (!latestMessage) {
    throw new EmptyChatTranscriptError();
  }

  return buildPrompt(chatTitle, [
    buildOmittedTranscriptSummary(formattedMessages.slice(0, -1)),
    latestMessage.compact,
  ]);
}
