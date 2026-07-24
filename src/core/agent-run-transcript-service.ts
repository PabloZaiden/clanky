import type { AgentRun, ChatTranscriptPage, ToolCallRecord } from "@/shared";
import {
  getTranscriptMeta,
  getTranscriptToolCall,
  listTranscriptEntries,
} from "../persistence/transcripts/store";
import { loadAgentRunSummary } from "../persistence/agents";
import {
  createTranscriptPageFromStorageEntries,
  normalizeTranscriptPageSize,
  parseTranscriptCursor,
} from "./transcript-service";

export type AgentRunTranscriptSnapshotRun = Omit<AgentRun, "messages" | "logs" | "toolCalls">;

export interface AgentRunTranscriptSnapshot {
  run: AgentRunTranscriptSnapshotRun;
  transcript: ChatTranscriptPage;
}

function createAgentRunTranscriptPage(
  runId: string,
  limit: number | undefined,
  before?: string,
): ChatTranscriptPage {
  const meta = getTranscriptMeta("agent_run", runId);
  if (!meta) {
    throw new Error(`Agent-run transcript metadata is unavailable: ${runId}`);
  }
  const entries = listTranscriptEntries(
    "agent_run",
    runId,
    before ? parseTranscriptCursor(before) : undefined,
    limit === undefined ? undefined : limit + 1,
  );
  return createTranscriptPageFromStorageEntries(entries, limit, before, {
    revision: meta.revision,
    totalEntries: meta.entryCount,
  });
}

export async function getAgentRunTranscriptSnapshot(
  runId: string,
): Promise<AgentRunTranscriptSnapshot | null> {
  const run = await loadAgentRunSummary(runId);
  if (!run) {
    return null;
  }
  if (!getTranscriptMeta("agent_run", runId)) {
    throw new Error(`Agent-run transcript metadata is unavailable: ${runId}`);
  }
  const { messages: _messages, logs: _logs, toolCalls: _toolCalls, ...runSnapshot } = run;
  return {
    run: runSnapshot,
    transcript: createAgentRunTranscriptPage(runId, undefined),
  };
}

export async function getAgentRunTranscriptPage(
  runId: string,
  limit: number,
  before?: string,
): Promise<ChatTranscriptPage | null> {
  const run = await loadAgentRunSummary(runId);
  if (!run) {
    return null;
  }
  if (!getTranscriptMeta("agent_run", runId)) {
    throw new Error(`Agent-run transcript metadata is unavailable: ${runId}`);
  }
  return createAgentRunTranscriptPage(runId, limit, before);
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
    throw new Error(`Agent-run transcript metadata is unavailable: ${runId}`);
  }
  return getTranscriptToolCall("agent_run", runId, toolCallId);
}

export { normalizeTranscriptPageSize };
