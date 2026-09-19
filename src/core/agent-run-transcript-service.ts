import type {
  AgentRun,
  ChatTranscript,
  ToolCallRecord,
  TranscriptSnapshotOptions,
} from "@/shared";
import { agentRunTranscriptStore } from "../persistence/transcripts/agent-run-store";
import { loadAgentRunSummary } from "../persistence/agents";
import { createTranscriptFromStoragePage } from "./transcript-service";

export type AgentRunTranscriptSnapshotRun = Omit<AgentRun, "messages" | "logs" | "toolCalls">;

export interface AgentRunTranscriptSnapshot {
  run: AgentRunTranscriptSnapshotRun;
  transcript: ChatTranscript;
}

export async function getAgentRunTranscriptSnapshot(
  runId: string,
  options: TranscriptSnapshotOptions = {},
): Promise<AgentRunTranscriptSnapshot | null> {
  const run = await loadAgentRunSummary(runId);
  if (!run) {
    return null;
  }

  const meta = agentRunTranscriptStore.getMeta(runId);
  if (!meta) {
    throw new Error(`Agent run transcript metadata is unavailable: ${runId}`);
  }

  const { messages: _messages, logs: _logs, toolCalls: _toolCalls, ...runWithoutTranscript } = run;
  return {
    run: runWithoutTranscript,
    transcript: createTranscriptFromStoragePage(
      agentRunTranscriptStore.listPage(runId, options),
      {
        revision: meta.revision,
        totalEntries: meta.entryCount,
      },
    ),
  };
}

export async function getAgentRunTranscriptToolCall(
  runId: string,
  toolCallId: string,
): Promise<ToolCallRecord | null> {
  const run = await loadAgentRunSummary(runId);
  if (!run) {
    return null;
  }
  if (!agentRunTranscriptStore.getMeta(runId)) {
    throw new Error(`Agent run transcript metadata is unavailable: ${runId}`);
  }
  return agentRunTranscriptStore.getToolCall(runId, toolCallId);
}
