import type {
  MessageData,
  PersistedMessage,
  PersistedToolCall,
  TaskLogEntry,
  ToolCallExtra,
} from "@/shared";
import { mergeToolCallRecord, upsertToolCallExtra } from "@/shared/tool-call";
import { TranscriptChangeTracker } from "./transcript-change-tracker";
import { TranscriptMemoryIndex } from "./transcript-memory-index";

export interface TranscriptStreamState {
  messages: PersistedMessage[];
  logs: TaskLogEntry[];
  toolCalls: PersistedToolCall[];
}

export interface TranscriptStreamProjectionLimits {
  maxMessages: number;
  maxLogs: number;
  maxToolCalls: number;
}

/**
 * Shared in-memory transcript projection for task and agent-run streams.
 *
 * Domain owners still decide when to persist and how to publish state. This
 * class owns only indexed collections, eviction, and incremental change
 * tracking so those two stream consumers cannot drift apart.
 */
export class TranscriptStreamProjection {
  readonly changes = new TranscriptChangeTracker();
  private messageMemory: TranscriptMemoryIndex<PersistedMessage>;
  private logMemory: TranscriptMemoryIndex<TaskLogEntry>;
  private toolMemory: TranscriptMemoryIndex<PersistedToolCall>;
  private readonly limits: TranscriptStreamProjectionLimits;

  constructor(state: TranscriptStreamState, limits: TranscriptStreamProjectionLimits) {
    this.limits = limits;
    this.messageMemory = new TranscriptMemoryIndex(state.messages, limits.maxMessages);
    this.logMemory = new TranscriptMemoryIndex(state.logs, limits.maxLogs);
    this.toolMemory = new TranscriptMemoryIndex(state.toolCalls, limits.maxToolCalls);
  }

  get state(): TranscriptStreamState {
    return {
      messages: this.messageMemory.values,
      logs: this.logMemory.values,
      toolCalls: this.toolMemory.values,
    };
  }

  get messages(): PersistedMessage[] {
    return this.messageMemory.values;
  }

  get logs(): TaskLogEntry[] {
    return this.logMemory.values;
  }

  get toolCalls(): PersistedToolCall[] {
    return this.toolMemory.values;
  }

  getMessage(id: string): PersistedMessage | undefined {
    return this.messageMemory.get(id);
  }

  getLog(id: string): TaskLogEntry | undefined {
    return this.logMemory.get(id);
  }

  getToolCall(id: string): PersistedToolCall | undefined {
    return this.toolMemory.get(id);
  }

  upsertMessage(message: MessageData): void {
    const existing = this.messageMemory.get(message.id);
    const persistedMessage: PersistedMessage = {
      id: message.id,
      role: message.role,
      content: message.content,
      attachments: message.attachments ?? existing?.attachments,
      timestamp: message.timestamp,
    };
    const { evicted } = this.messageMemory.upsert(persistedMessage);
    this.recordEvictions("message", evicted);
    if (this.messageMemory.has(message.id)) {
      this.changes.recordUpsert("message", persistedMessage);
    }
  }

  upsertLog(entry: TaskLogEntry): void {
    const { evicted } = this.logMemory.upsert(entry);
    this.recordEvictions("log", evicted);
    if (this.logMemory.has(entry.id)) {
      this.changes.recordUpsert("log", entry);
    }
  }

  upsertToolCall(toolCall: PersistedToolCall): void {
    const existing = this.toolMemory.get(toolCall.id);
    const persistedTool = existing
      ? mergeToolCallRecord(existing, toolCall)
      : toolCall;
    const { evicted } = this.toolMemory.upsert(persistedTool);
    this.recordEvictions("tool", evicted);
    if (this.toolMemory.has(persistedTool.id)) {
      this.changes.recordUpsert("tool", persistedTool);
    }
  }

  upsertToolCallExtra(toolId: string, extra: ToolCallExtra): boolean {
    const existing = this.toolMemory.get(toolId);
    if (!existing) {
      return false;
    }
    const updated = {
      ...existing,
      extras: upsertToolCallExtra(existing.extras, extra),
    };
    this.toolMemory.upsert(updated);
    this.changes.recordUpsert("tool", updated);
    return true;
  }

  replace(state: TranscriptStreamState): void {
    this.messageMemory = new TranscriptMemoryIndex(state.messages, this.limits.maxMessages);
    this.logMemory = new TranscriptMemoryIndex(state.logs, this.limits.maxLogs);
    this.toolMemory = new TranscriptMemoryIndex(state.toolCalls, this.limits.maxToolCalls);
  }

  private recordEvictions(
    kind: "message" | "log" | "tool",
    evicted: Array<{ id: string }>,
  ): void {
    for (const entry of evicted) {
      this.changes.recordDelete(kind, entry.id);
    }
  }
}
