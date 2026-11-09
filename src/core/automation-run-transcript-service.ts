import type {
  AutomationRun,
  ChatTranscript,
  ToolCallRecord,
  TranscriptSnapshotOptions,
} from "@/shared";
import { automationRunTranscriptStore } from "../persistence/transcripts/automation-run-store";
import { loadAutomationRunSummary } from "../persistence/automations";
import { createTranscriptFromStoragePage, includeLiveTranscript, withLiveToolCallRevision } from "./transcript-service";
import { automationRunner } from "./automation-runner";

export type AutomationRunTranscriptSnapshotRun = Omit<AutomationRun, "messages" | "logs" | "toolCalls">;

export interface AutomationRunTranscriptSnapshot {
  run: AutomationRunTranscriptSnapshotRun;
  transcript: ChatTranscript;
}

export async function getAutomationRunTranscriptSnapshot(
  runId: string,
  options: TranscriptSnapshotOptions = {},
): Promise<AutomationRunTranscriptSnapshot | null> {
  const run = await loadAutomationRunSummary(runId);
  if (!run) {
    return null;
  }

  const meta = automationRunTranscriptStore.getMeta(runId);
  if (!meta) {
    throw new Error(`Automation run transcript metadata is unavailable: ${runId}`);
  }

  const { messages: _messages, logs: _logs, toolCalls: _toolCalls, ...runWithoutTranscript } = run;
  return {
    run: runWithoutTranscript,
    transcript: includeLiveTranscript(createTranscriptFromStoragePage(
      automationRunTranscriptStore.listPage(runId, options),
      {
        revision: meta.revision,
        totalEntries: meta.entryCount,
      },
    ), automationRunner.getLiveTranscript(runId), { window: options }),
  };
}

export async function getAutomationRunTranscriptToolCall(
  runId: string,
  toolCallId: string,
): Promise<ToolCallRecord | null> {
  const run = await loadAutomationRunSummary(runId);
  if (!run) {
    return null;
  }
  if (!automationRunTranscriptStore.getMeta(runId)) {
    throw new Error(`Automation run transcript metadata is unavailable: ${runId}`);
  }
  const tool = automationRunner.getLiveTranscript(runId)?.toolCalls.find((tool) => tool.id === toolCallId);
  return tool ? withLiveToolCallRevision(tool) : automationRunTranscriptStore.getToolCall(runId, toolCallId);
}
