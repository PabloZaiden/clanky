import type { AgentRun, ChatTranscript, ToolCallRecord } from "@/shared";
import {
  getTranscriptMeta,
  getTranscriptToolCall,
  listTranscriptEntries,
} from "../persistence/transcripts/store";
import { loadAgentRun } from "../persistence/agents";
import { createTranscriptFromStorageEntries } from "./transcript-service";

export type AgentRunTranscriptSnapshotRun = Omit<AgentRun, "messages" | "logs" | "toolCalls">;

export interface AgentRunTranscriptSnapshot {
  run: AgentRunTranscriptSnapshotRun;
  transcript: ChatTranscript;
}

export async function getAgentRunTranscriptSnapshot(
  runId: string,
): Promise<AgentRunTranscriptSnapshot | null> {
  const run = await loadAgentRun(runId);
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
    transcript: createTranscriptFromStorageEntries(
      listTranscriptEntries("agent_run", runId),
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
  const run = await loadAgentRun(runId);
  if (!run) {
    return null;
  }
  if (!getTranscriptMeta("agent_run", runId)) {
    throw new Error(`Agent run transcript metadata is unavailable: ${runId}`);
  }
  return getTranscriptToolCall("agent_run", runId, toolCallId);
}
