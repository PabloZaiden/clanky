import type {
  AgentRun,
  MessageData,
  PersistedToolCall,
  TaskLogEntry,
  TranscriptEntryPayload,
  ToolCallExtra,
} from "@/shared";
import type { ChatEvent } from "@/shared/events";
import { createLogger } from "@pablozaiden/webapp/server";
import {
  AgentStreamCheckpointPolicy,
  getAgentStreamTextByteLength,
} from "./agent-stream-controller";
import { MAX_PERSISTED_LOGS, MAX_PERSISTED_MESSAGES, MAX_PERSISTED_TOOL_CALLS } from "./engine/engine-types";
import { MemoryFirstPersistenceQueue } from "./memory-first-persistence-queue";
import { TranscriptStreamProjection } from "./transcript-stream-projection";
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
  private readonly transcript: TranscriptStreamProjection;
  private readonly checkpointPolicy = new AgentStreamCheckpointPolicy();
  private readonly persistenceQueue = new MemoryFirstPersistenceQueue(true);
  private persistenceError: unknown = null;

  constructor(run: AgentRun) {
    this.run = run;
    this.transcript = new TranscriptStreamProjection(run, {
      maxMessages: MAX_PERSISTED_MESSAGES,
      maxLogs: MAX_PERSISTED_LOGS,
      maxToolCalls: MAX_PERSISTED_TOOL_CALLS,
    });
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
    await this.persistenceQueue.request(() => this.persistCurrentState());
    this.raisePersistenceError();
  }

  async adoptRun(run: AgentRun): Promise<void> {
    await this.persistForFinalization();
    this.reconcileTranscript("message", this.transcript.messages, run.messages);
    this.reconcileTranscript("log", this.transcript.logs, run.logs);
    this.reconcileTranscript("tool", this.transcript.toolCalls, run.toolCalls);
    this.run = run;
    this.transcript.replace(run);
    this.markOperationalPersistenceDirty();
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

  private async persistCurrentState(): Promise<void> {
    const checkpointedTextBytes = this.checkpointPolicy.getPendingTextBytes();
    const operationalPersistenceVersion = this.persistenceQueue.operationalVersion;
    const snapshot = this.transcript.changes.snapshot(this.run);
    if (
      !this.persistenceQueue.isOperationalPersistenceDirty
      && snapshot.changes.upserts.length === 0
      && snapshot.changes.deletes.length === 0
    ) {
      return;
    }

    await saveAgentRun(this.run, {
      transcriptChanges: snapshot.changes,
    });
    this.transcript.changes.acknowledge(snapshot);
    this.persistenceQueue.acknowledgeOperationalPersistence(operationalPersistenceVersion);
    this.checkpointPolicy.markCheckpoint(checkpointedTextBytes);
  }

  private markOperationalPersistenceDirty(): void {
    this.persistenceQueue.markOperationalPersistenceDirty();
  }

  private upsertMessage(message: MessageData): void {
    this.transcript.upsertMessage(message);
    this.run = {
      ...this.run,
      messages: this.transcript.messages,
      updatedAt: message.timestamp,
    };
  }

  private upsertMessageDelta(event: Extract<ChatEvent, { type: "chat.message.delta" }>): void {
    const existing = this.transcript.getMessage(event.messageId);
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
    this.transcript.upsertLog(entry);
    this.run = {
      ...this.run,
      logs: this.transcript.logs,
      updatedAt: entry.timestamp,
    };
  }

  private upsertLogDelta(event: Extract<ChatEvent, { type: "chat.log.delta" }>): void {
    const existing = this.transcript.getLog(event.logId);
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
    this.transcript.upsertToolCall(tool);
    this.run = {
      ...this.run,
      toolCalls: this.transcript.toolCalls,
      updatedAt: tool.timestamp,
    };
  }

  private upsertToolCallExtra(toolId: string, extra: ToolCallExtra, timestamp = new Date().toISOString()): void {
    if (!this.transcript.upsertToolCallExtra(toolId, extra)) {
      return;
    }
    this.run = {
      ...this.run,
      toolCalls: this.transcript.toolCalls,
      updatedAt: timestamp,
    };
  }

  private reconcileTranscript<T extends TranscriptEntryPayload>(
    kind: "message" | "log" | "tool",
    current: T[],
    nextEntries: T[],
  ): void {
    const currentById = new Map(current.map((entry) => [entry.id, entry]));
    const nextIds = new Set<string>();
    for (const entry of nextEntries) {
      nextIds.add(entry.id);
      const currentEntry = currentById.get(entry.id);
      if (!currentEntry || JSON.stringify(currentEntry) !== JSON.stringify(entry)) {
        this.transcript.changes.recordUpsert(kind, entry);
      }
    }
    for (const entry of current) {
      if (!nextIds.has(entry.id)) {
        this.transcript.changes.recordDelete(kind, entry.id);
      }
    }
  }

  private raisePersistenceError(): void {
    if (this.persistenceError) {
      throw this.persistenceError;
    }
  }
}
