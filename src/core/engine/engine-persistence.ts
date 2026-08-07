/**
 * Persistence ownership for TaskEngine transcript and operational state.
 */

import type { TaskLogEntry, TaskState } from "@/shared/task";
import type { MessageData, ToolCallData } from "@/shared/events";
import type {
  TaskEngineOptions,
} from "./engine-types";
import {
  AgentStreamCheckpointPolicy,
} from "../agent-stream-controller";
import { MemoryFirstPersistenceQueue } from "../memory-first-persistence-queue";
import { TranscriptStreamProjection } from "../transcript-stream-projection";
import {
  MAX_PERSISTED_LOGS,
  MAX_PERSISTED_MESSAGES,
  MAX_PERSISTED_TOOL_CALLS,
} from "./engine-types";
import { log } from "@pablozaiden/webapp/server";

export interface TaskPersistenceCoordinatorOptions {
  state: TaskState;
  onPersistState?: TaskEngineOptions["onPersistState"];
}

/**
 * Owns the mutable transcript projection and serialized state checkpoints.
 *
 * TaskEngine remains responsible for deciding when operational state changes,
 * while this coordinator owns the durability resources used to persist them.
 */
export class TaskPersistenceCoordinator {
  private readonly state: TaskState;
  private onPersistState?: TaskEngineOptions["onPersistState"];
  private readonly transcript: TranscriptStreamProjection;
  private readonly streamCheckpointPolicy = new AgentStreamCheckpointPolicy();
  private readonly persistenceQueue = new MemoryFirstPersistenceQueue();

  constructor(options: TaskPersistenceCoordinatorOptions) {
    this.state = options.state;
    this.onPersistState = options.onPersistState;
    this.transcript = new TranscriptStreamProjection(this.state, {
      maxMessages: MAX_PERSISTED_MESSAGES,
      maxLogs: MAX_PERSISTED_LOGS,
      maxToolCalls: MAX_PERSISTED_TOOL_CALLS,
    });
  }

  async flush(): Promise<void> {
    await this.trigger();
  }

  get checkpointPolicy(): AgentStreamCheckpointPolicy {
    return this.streamCheckpointPolicy;
  }

  disable(): void {
    this.onPersistState = undefined;
  }

  markOperationalPersistenceDirty(): void {
    this.persistenceQueue.markOperationalPersistenceDirty();
  }

  trigger(): Promise<void> {
    return this.persistenceQueue.request(() => this.persistCurrentState());
  }

  persistLog(entry: TaskLogEntry): void {
    this.transcript.upsertLog(entry);
    this.state.logs = this.transcript.logs;
  }

  persistMessage(message: MessageData): void {
    this.transcript.upsertMessage(message);
    this.state.messages = this.transcript.messages;
  }

  persistToolCall(toolCall: ToolCallData): void {
    this.transcript.upsertToolCall(toolCall);
    this.state.toolCalls = this.transcript.toolCalls;
  }

  getLog(id: string): TaskLogEntry | undefined {
    return this.transcript.getLog(id);
  }

  getToolCall(id: string): ToolCallData | undefined {
    return this.transcript.getToolCall(id);
  }

  private async persistCurrentState(): Promise<void> {
    if (!this.onPersistState) {
      return;
    }

    const checkpointedTextBytes = this.streamCheckpointPolicy.getPendingTextBytes();
    const operationalPersistenceVersion = this.persistenceQueue.operationalVersion;
    const snapshot = this.transcript.changes.snapshot(this.state);
    if (
      !this.persistenceQueue.isOperationalPersistenceDirty
      && snapshot.changes.upserts.length === 0
      && snapshot.changes.deletes.length === 0
    ) {
      return;
    }

    try {
      await this.onPersistState(this.state, {
        transcriptChanges: snapshot.changes,
      });
      this.transcript.changes.acknowledge(snapshot);
      this.persistenceQueue.acknowledgeOperationalPersistence(operationalPersistenceVersion);
      this.streamCheckpointPolicy.markCheckpoint(checkpointedTextBytes);
    } catch (error) {
      log.error(`Failed to persist task state: ${String(error)}`);
      throw error;
    }
  }
}
