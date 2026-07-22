import type { AgentRun } from "@/shared/agent";
import type { TaskLogEntry } from "@/shared/task";
import { createTimestamp } from "@/shared/events";
import { saveAgentRun } from "../persistence/agents";
import { agentEventEmitter } from "./event-emitter";
import { MAX_PERSISTED_LOGS } from "./engine/engine-types";

const MAX_OUTPUT_ENTRY_LENGTH = 16_384;

export type DeterministicOutputStream = "stdout" | "stderr";

export interface DeterministicAgentOutputDetails {
  stream: DeterministicOutputStream;
}

export interface DeterministicAgentOutputOptions {
  persist?: boolean;
  emit?: boolean;
  userId?: string;
  eventAgentRunId?: string;
  onAppend?: (entry: TaskLogEntry) => void;
}

function normalizeOutput(text: string): { message: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_ENTRY_LENGTH) {
    return { message: text, truncated: false };
  }
  return {
    message: `${text.slice(0, MAX_OUTPUT_ENTRY_LENGTH)}\n[output truncated]`,
    truncated: true,
  };
}

export class DeterministicAgentOutput {
  private currentRun: AgentRun;
  private persistenceQueue = Promise.resolve();
  private persistenceError: unknown;
  private readonly persist: boolean;
  private readonly emit: boolean;
  private readonly userId?: string;
  private readonly eventAgentRunId?: string;
  private readonly onAppend?: (entry: TaskLogEntry) => void;

  constructor(run: AgentRun, options: DeterministicAgentOutputOptions = {}) {
    this.currentRun = run;
    this.persist = options.persist ?? true;
    this.emit = options.emit ?? true;
    this.userId = options.userId;
    this.eventAgentRunId = options.eventAgentRunId;
    this.onAppend = options.onAppend;
  }

  get run(): AgentRun {
    return this.currentRun;
  }

  append(stream: DeterministicOutputStream, text: string): void {
    if (text.length === 0) {
      return;
    }

    const normalized = normalizeOutput(text);
    const timestamp = createTimestamp();
    const entry: TaskLogEntry = {
      id: crypto.randomUUID(),
      level: stream === "stderr" ? "error" : "info",
      message: normalized.message,
      details: {
        stream,
        ...(normalized.truncated ? { truncated: true } : {}),
      } satisfies DeterministicAgentOutputDetails & { truncated?: boolean },
      timestamp,
    };
    const logs = [...this.currentRun.logs, entry];
    if (logs.length > MAX_PERSISTED_LOGS) {
      logs.splice(0, logs.length - MAX_PERSISTED_LOGS);
    }
    this.currentRun = {
      ...this.currentRun,
      logs,
      updatedAt: timestamp,
    };
    this.onAppend?.(entry);
    if (this.emit) {
      agentEventEmitter.emit(
        {
          type: "agent.run.log",
          agentId: this.currentRun.agentId,
          agentRunId: this.eventAgentRunId ?? this.currentRun.id,
          log: entry,
          timestamp,
        },
        this.userId ? { userId: this.userId } : undefined,
      );
    }

    if (this.persist) {
      const snapshot = this.currentRun;
      this.persistenceQueue = this.persistenceQueue
        .then(async () => {
          await saveAgentRun(snapshot);
        })
        .catch((error) => {
          this.persistenceError ??= error;
        });
    }
  }

  async flush(): Promise<AgentRun> {
    if (!this.persist) {
      return this.currentRun;
    }
    await this.persistenceQueue;
    if (this.persistenceError !== undefined) {
      throw new Error("Failed to persist deterministic agent output", {
        cause: this.persistenceError,
      });
    }
    return this.currentRun;
  }
}
