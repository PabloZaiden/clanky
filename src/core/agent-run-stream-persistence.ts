import type {
  AgentRun,
  MessageData,
  PersistedMessage,
  PersistedToolCall,
  TaskLogEntry,
  ToolCallExtra,
} from "@/shared";
import type { ChatEvent } from "@/shared/events";
import { mergeToolCallRecord, upsertToolCallExtra } from "@/shared/tool-call";
import { createLogger } from "@pablozaiden/webapp/server";
import {
  AgentStreamCheckpointPolicy,
  getAgentStreamTextByteLength,
} from "./agent-stream-controller";
import { MAX_PERSISTED_LOGS, MAX_PERSISTED_MESSAGES, MAX_PERSISTED_TOOL_CALLS } from "./engine/engine-types";
import { TranscriptChangeTracker } from "./transcript-change-tracker";
import { TranscriptMemoryIndex } from "./transcript-memory-index";
import { saveAgentRun } from "../persistence/agents";

const log = createLogger("agent-run-stream-persistence");

/**
 * Keeps the agent-run projection current while its ACP chat is streaming.
 *
 * The associated agent chat owns ACP consumption and its own transcript. This
 * projection is updated from chat events so agent-run recovery does not wait
 * for the stream to finish or rebuild the complete transcript on every delta.
 */
export class AgentRunStreamPersistence {
  private run: AgentRun;
  private readonly transcriptChanges = new TranscriptChangeTracker();
  private messages: TranscriptMemoryIndex<PersistedMessage>;
  private logs: TranscriptMemoryIndex<TaskLogEntry>;
  private toolCalls: TranscriptMemoryIndex<PersistedToolCall>;
  private readonly checkpointPolicy = new AgentStreamCheckpointPolicy();
  private persistenceInFlight: Promise<void> | null = null;
  private persistenceRequested = false;
  private persistenceError: unknown = null;
  private operationalPersistenceDirty = true;
  private operationalPersistenceVersion = 1;

  constructor(run: AgentRun) {
    this.run = run;
    this.messages = new TranscriptMemoryIndex(run.messages, MAX_PERSISTED_MESSAGES);
    this.logs = new TranscriptMemoryIndex(run.logs, MAX_PERSISTED_LOGS);
    this.toolCalls = new TranscriptMemoryIndex(run.toolCalls, MAX_PERSISTED_TOOL_CALLS);
  }

  get currentRun(): AgentRun {
    return this.run;
  }

  handleChatEvent(event: ChatEvent): void {
    let shouldCheckpoint = false;
    switch (event.type) {
      case "chat.updated":
        this.run = {
          ...this.run,
          pendingPermissionRequests: event.chat.state.pendingPermissionRequests,
          session: event.chat.state.session,
          worktree: event.chat.state.worktree,
          updatedAt: event.timestamp,
        };
        this.markOperationalPersistenceDirty();
        shouldCheckpoint = true;
        break;
      case "chat.message":
        this.upsertMessage(event.message);
        shouldCheckpoint = true;
        break;
      case "chat.message.delta":
        this.upsertMessageDelta(event);
        shouldCheckpoint = this.checkpointPolicy.recordText(
          getAgentStreamTextByteLength(event.delta),
        );
        break;
      case "chat.log":
        this.upsertLog(event.log);
        shouldCheckpoint = true;
        break;
      case "chat.log.delta":
        this.upsertLogDelta(event);
        shouldCheckpoint = this.checkpointPolicy.recordText(
          getAgentStreamTextByteLength(event.delta),
        );
        break;
      case "chat.tool_call":
        this.upsertToolCall(event.tool);
        shouldCheckpoint = true;
        break;
      case "chat.tool_call.extra":
        this.upsertToolCallExtra(event.toolId, event.extra, event.timestamp);
        shouldCheckpoint = true;
        break;
      case "chat.error":
        this.run = {
          ...this.run,
          status: "failed",
          completedAt: event.timestamp,
          error: {
            message: event.message,
            timestamp: event.timestamp,
            ...(event.code ? { code: event.code } : {}),
          },
          updatedAt: event.timestamp,
        };
        this.markOperationalPersistenceDirty();
        shouldCheckpoint = true;
        break;
      case "chat.interrupted":
        this.run = {
          ...this.run,
          status: "interrupted",
          completedAt: event.timestamp,
          updatedAt: event.timestamp,
        };
        this.markOperationalPersistenceDirty();
        shouldCheckpoint = true;
        break;
      case "chat.status":
        this.run = {
          ...this.run,
          updatedAt: event.timestamp,
        };
        this.markOperationalPersistenceDirty();
        shouldCheckpoint = true;
        break;
      default:
        return;
    }

    if (shouldCheckpoint) {
      this.schedulePersistence();
    }
  }

  handleOutputLog(entry: TaskLogEntry): void {
    this.upsertLog(entry);
    const shouldCheckpoint = entry.level === "error"
      || this.checkpointPolicy.recordText(getAgentStreamTextByteLength(entry.message));
    if (shouldCheckpoint) {
      this.schedulePersistence();
    }
  }

  async persist(): Promise<void> {
    this.raisePersistenceError();
    this.persistenceRequested = true;
    if (!this.persistenceInFlight) {
      this.persistenceInFlight = this.drainPersistence();
    }
    await this.persistenceInFlight;
    this.raisePersistenceError();
  }

  async adoptRun(run: AgentRun): Promise<void> {
    await this.persistForFinalization();
    const nextMessageIds = new Set(run.messages.map((message) => message.id));
    const nextLogIds = new Set(run.logs.map((entry) => entry.id));
    const nextToolIds = new Set(run.toolCalls.map((toolCall) => toolCall.id));
    for (const message of this.run.messages) {
      if (!nextMessageIds.has(message.id)) {
        this.transcriptChanges.recordDelete("message", message.id);
      }
    }
    for (const entry of this.run.logs) {
      if (!nextLogIds.has(entry.id)) {
        this.transcriptChanges.recordDelete("log", entry.id);
      }
    }
    for (const toolCall of this.run.toolCalls) {
      if (!nextToolIds.has(toolCall.id)) {
        this.transcriptChanges.recordDelete("tool", toolCall.id);
      }
    }
    this.run = run;
    this.messages = new TranscriptMemoryIndex(run.messages, MAX_PERSISTED_MESSAGES);
    this.logs = new TranscriptMemoryIndex(run.logs, MAX_PERSISTED_LOGS);
    this.toolCalls = new TranscriptMemoryIndex(run.toolCalls, MAX_PERSISTED_TOOL_CALLS);
    this.markOperationalPersistenceDirty();
    this.recordFullTranscript(run);
    await this.persistForFinalization();
  }

  private async persistForFinalization(): Promise<void> {
    this.persistenceError = null;
    try {
      await this.persist();
    } catch (error) {
      this.persistenceError = null;
      try {
        await this.persist();
      } catch (retryError) {
        this.persistenceError = retryError;
        throw new Error("Failed to persist the final agent-run state", {
          cause: retryError,
        });
      }
      log.warn("Recovered agent-run finalization after a checkpoint failure", {
        runId: this.run.id,
        error: String(error),
      });
    }
  }

  private schedulePersistence(): void {
    if (this.persistenceError) {
      return;
    }
    void this.persist().catch((error) => {
      if (!this.persistenceError) {
        this.persistenceError = error;
        log.error("Failed to persist agent-run stream", {
          runId: this.run.id,
          error: String(error),
        });
      }
    });
  }

  private async drainPersistence(): Promise<void> {
    try {
      do {
        this.persistenceRequested = false;
        await this.persistCurrentState();
      } while (this.persistenceRequested);
    } finally {
      this.persistenceInFlight = null;
    }
  }

  private async persistCurrentState(): Promise<void> {
    const checkpointedTextBytes = this.checkpointPolicy.getPendingTextBytes();
    const operationalPersistenceVersion = this.operationalPersistenceVersion;
    const snapshot = this.transcriptChanges.snapshot(this.run);
    if (
      !this.operationalPersistenceDirty
      && snapshot.changes.upserts.length === 0
      && snapshot.changes.deletes.length === 0
    ) {
      return;
    }

    await saveAgentRun(this.run, {
      transcriptChanges: snapshot.changes,
    });
    this.transcriptChanges.acknowledge(snapshot);
    if (this.operationalPersistenceVersion === operationalPersistenceVersion) {
      this.operationalPersistenceDirty = false;
    } else {
      this.persistenceRequested = true;
    }
    this.checkpointPolicy.markCheckpoint(checkpointedTextBytes);
  }

  private markOperationalPersistenceDirty(): void {
    this.operationalPersistenceDirty = true;
    this.operationalPersistenceVersion += 1;
    if (this.persistenceInFlight) {
      this.persistenceRequested = true;
    }
  }

  private upsertMessage(message: MessageData): void {
    const existing = this.messages.get(message.id);
    const persistedMessage: PersistedMessage = {
      id: message.id,
      role: message.role,
      content: message.content,
      attachments: message.attachments ?? existing?.attachments,
      timestamp: message.timestamp,
    };
    const { evicted } = this.messages.upsert(persistedMessage);
    this.run = {
      ...this.run,
      messages: this.messages.values,
      updatedAt: message.timestamp,
    };
    for (const entry of evicted) {
      this.transcriptChanges.recordDelete("message", entry.id);
    }
    if (this.messages.has(message.id)) {
      this.transcriptChanges.recordUpsert("message", persistedMessage);
    }
  }

  private upsertMessageDelta(event: Extract<ChatEvent, { type: "chat.message.delta" }>): void {
    const existing = this.messages.get(event.messageId);
    const currentContent = existing?.content ?? "";
    const content = existing && currentContent.length >= event.baseLength
      ? `${currentContent.slice(0, event.baseLength)}${event.delta}`
      : `${currentContent}${event.delta}`;
    this.upsertMessage({
      id: event.messageId,
      role: event.role,
      content,
      timestamp: existing?.timestamp ?? event.messageTimestamp,
    });
  }

  private upsertLog(entry: TaskLogEntry): void {
    const { evicted } = this.logs.upsert(entry);
    this.run = {
      ...this.run,
      logs: this.logs.values,
      updatedAt: entry.timestamp,
    };
    for (const oldEntry of evicted) {
      this.transcriptChanges.recordDelete("log", oldEntry.id);
    }
    if (this.logs.has(entry.id)) {
      this.transcriptChanges.recordUpsert("log", entry);
    }
  }

  private upsertLogDelta(event: Extract<ChatEvent, { type: "chat.log.delta" }>): void {
    const existing = this.logs.get(event.logId);
    const existingContent = typeof existing?.details?.["responseContent"] === "string"
      ? existing.details["responseContent"]
      : "";
    const responseContent = existing && existingContent.length >= event.baseLength
      ? `${existingContent.slice(0, event.baseLength)}${event.delta}`
      : `${existingContent}${event.delta}`;
    this.upsertLog({
      id: event.logId,
      level: event.level,
      message: event.message,
      details: {
        ...(existing?.details ?? {}),
        logKind: event.logKind,
        responseContent,
      },
      timestamp: existing?.timestamp ?? event.logTimestamp,
    });
  }

  private upsertToolCall(tool: PersistedToolCall): void {
    const existing = this.toolCalls.get(tool.id);
    const mergedTool = existing
      ? mergeToolCallRecord(existing, tool)
      : tool;
    const { evicted } = this.toolCalls.upsert(mergedTool);
    this.run = {
      ...this.run,
      toolCalls: this.toolCalls.values,
      updatedAt: tool.timestamp,
    };
    for (const oldTool of evicted) {
      this.transcriptChanges.recordDelete("tool", oldTool.id);
    }
    if (this.toolCalls.has(mergedTool.id)) {
      this.transcriptChanges.recordUpsert("tool", mergedTool);
    }
  }

  private upsertToolCallExtra(toolId: string, extra: ToolCallExtra, timestamp = new Date().toISOString()): void {
    const existing = this.toolCalls.get(toolId);
    if (!existing) {
      return;
    }
    const updated = {
      ...existing,
      extras: upsertToolCallExtra(existing.extras, extra),
    };
    this.run = {
      ...this.run,
      toolCalls: this.toolCalls.values,
      updatedAt: timestamp,
    };
    this.toolCalls.upsert(updated);
    this.transcriptChanges.recordUpsert("tool", updated);
  }

  private recordFullTranscript(run: AgentRun): void {
    for (const message of run.messages) {
      this.transcriptChanges.recordUpsert("message", message);
    }
    for (const logEntry of run.logs) {
      this.transcriptChanges.recordUpsert("log", logEntry);
    }
    for (const toolCall of run.toolCalls) {
      this.transcriptChanges.recordUpsert("tool", toolCall);
    }
  }

  private raisePersistenceError(): void {
    if (this.persistenceError) {
      throw this.persistenceError;
    }
  }
}
