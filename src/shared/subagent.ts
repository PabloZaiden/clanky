import type { ChatTranscript } from "./chat-transcript";
import type { HarnessActivity, HarnessConversationBinding } from "./harness-control";
import type { HarnessEvent } from "./harness-events";
import type { StreamDeltaPosition } from "./stream-position";
import type { TranscriptStreamEvent } from "./transcript-events";

export interface SubagentContext {
  kind: "chat" | "task";
  id: string;
}

export interface Subagent {
  id: string;
  chatId?: string;
  taskId?: string;
  workspaceId: string | null;
  binding: HarnessConversationBinding;
  activity: HarnessActivity;
  coverage: "partial" | "complete";
  observation: "connected" | "disconnected" | "unsupported" | "error";
  error?: string;
  unfinishedMessageIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SubagentSnapshot {
  subagent: Subagent;
  transcript: ChatTranscript;
}

export interface SubagentList {
  items: Subagent[];
  nextCursor?: string;
}

export interface HarnessSubagentHistory {
  events: HarnessEvent[];
  processing: boolean;
  nextCursor?: string;
}

export type SubagentEvent = {
  subagentId: string;
  chatId?: string;
  taskId?: string;
  timestamp: string;
} & (
  | { type: "subagent.changed" }
  | {
      type: "subagent.transcript";
      event: TranscriptStreamEvent;
      streamPosition: StreamDeltaPosition;
    }
);
