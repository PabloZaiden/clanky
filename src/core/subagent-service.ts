import type { PersistedMessage, TranscriptSnapshotOptions } from "@/shared";
import type { Subagent, SubagentContext, SubagentList, SubagentSnapshot } from "@/shared/subagent";
import { getSubagentForContext, listSubagents } from "../persistence/subagents";
import { subagentTranscriptStore } from "../persistence/transcripts/subagent-store";
import { loadChatMetadata } from "../persistence/chats";
import { loadTaskSummary } from "../persistence/tasks";
import { requireResourcePersistenceUserId } from "../persistence/ownership";
import { DomainError } from "../domain/domain-error";
import { createTranscriptFromStoragePage } from "./transcript-service";
import { getSubagentStreamPosition } from "./subagent-transcript-observer";

async function parentExists(context: SubagentContext): Promise<boolean> {
  return context.kind === "chat" ? await loadChatMetadata(context.id) !== null : await loadTaskSummary(context.id) !== null;
}

function observed(record: Subagent): Subagent {
  return record.observation === "connected" && !getSubagentStreamPosition(record.id)
    ? { ...record, observation: "disconnected" } : record;
}

export async function getSavedSubagents(context: SubagentContext, before?: string): Promise<SubagentList | null> {
  if (!await parentExists(context)) return null;
  const page = listSubagents(context, before);
  return { ...page, items: page.items.map(observed) };
}

export async function getSavedSubagentSnapshot(
  context: SubagentContext, id: string, options: TranscriptSnapshotOptions = {},
): Promise<SubagentSnapshot | null> {
  if (!await parentExists(context)) return null;
  const record = getSubagentForContext(context, id);
  if (!record) return null;
  const meta = subagentTranscriptStore.getMeta(id);
  if (!meta) throw new DomainError("harness_event_gap", "The saved subagent transcript metadata is unavailable.");
  const transcript = createTranscriptFromStoragePage(subagentTranscriptStore.listPage(id, options), {
    revision: meta.revision, totalEntries: meta.entryCount,
  });
  const livePosition = getSubagentStreamPosition(id);
  if (livePosition) {
    transcript.position = livePosition;
    transcript.revision = `${meta.revision}:${livePosition.epoch}:${livePosition.revision}`;
  }
  return { subagent: observed(record), transcript };
}

export async function getSavedSubagentTool(context: SubagentContext, id: string, toolCallId: string) {
  if (!await parentExists(context) || !getSubagentForContext(context, id)) return null;
  return subagentTranscriptStore.getToolCall(id, toolCallId);
}

export async function getSavedSubagentAssistantMessage(
  context: SubagentContext, id: string, messageId: string,
): Promise<PersistedMessage | null> {
  if (!await parentExists(context) || !getSubagentForContext(context, id)) return null;
  const message = subagentTranscriptStore.getMessageForUser(id, requireResourcePersistenceUserId("subagent", id), messageId);
  return message?.role === "assistant" ? message : null;
}
