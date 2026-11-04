import type { MessageAttachment, PersistedMessage } from "@/shared";
import type { SubagentContext } from "@/shared/subagent";
import { loadTaskSummary } from "../persistence/tasks";
import { loadAgentRunSummary } from "../persistence/agents";
import { requireResourcePersistenceUserId } from "../persistence/ownership";
import { taskTranscriptStore } from "../persistence/transcripts/task-store";
import { agentRunTranscriptStore } from "../persistence/transcripts/agent-run-store";
import { chatManager } from "./chat-manager";
import { taskManager } from "./task";
import { agentRunner } from "./agent-runner";
import { getSavedSubagentMessage } from "./subagent-service";

type TranscriptAttachmentContext =
  | { kind: "chat" | "task" | "agent-run"; id: string }
  | { kind: "subagent"; id: string; parent: SubagentContext };

async function getAttachmentMessage(context: TranscriptAttachmentContext, messageId: string): Promise<PersistedMessage | null> {
  switch (context.kind) {
    case "chat":
      return chatManager.getMessage(context.id, messageId);
    case "task":
      if (!await loadTaskSummary(context.id)) return null;
      return taskManager.getLiveTranscript(context.id)?.messages.find((message) => message.id === messageId)
        ?? taskTranscriptStore.getMessageForUser(context.id, requireResourcePersistenceUserId("task", context.id), messageId);
    case "agent-run":
      if (!await loadAgentRunSummary(context.id)) return null;
      return agentRunner.getLiveTranscript(context.id)?.messages.find((message) => message.id === messageId)
        ?? agentRunTranscriptStore.getMessageForUser(context.id, requireResourcePersistenceUserId("agent-run", context.id), messageId);
    case "subagent":
      return getSavedSubagentMessage(context.parent, context.id, messageId);
  }
}

export async function getTranscriptAttachment(
  context: TranscriptAttachmentContext,
  messageId: string,
  attachmentId: string,
): Promise<MessageAttachment | null> {
  const message = await getAttachmentMessage(context, messageId);
  return message?.attachments?.find((attachment) => attachment.id === attachmentId) ?? null;
}
