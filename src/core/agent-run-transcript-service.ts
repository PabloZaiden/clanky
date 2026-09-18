import type {
  AgentRun,
  ChatTranscript,
  ToolCallRecord,
  TranscriptSnapshotOptions,
} from "@/shared";
import {
  getTranscriptMeta,
  getTranscriptToolCall,
  listTranscriptEntriesPage,
} from "../persistence/transcripts/store";
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

  const meta = getTranscriptMeta("agent_run", runId);
  if (!meta) {
    throw new Error(`Agent run transcript metadata is unavailable: ${runId}`);
  }

  const { messages: _messages, logs: _logs, toolCalls: _toolCalls, ...runWithoutTranscript } = run;
  return {
    run: runWithoutTranscript,
    transcript: createTranscriptFromStoragePage(
      listTranscriptEntriesPage("agent_run", runId, options),
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
  if (!getTranscriptMeta("agent_run", runId)) {
    throw new Error(`Agent run transcript metadata is unavailable: ${runId}`);
  }
  return getTranscriptToolCall("agent_run", runId, toolCallId);
}
