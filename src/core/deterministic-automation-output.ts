import type { AutomationRun } from "@/shared/automation";
import type { ConversationLogEntry } from "@/shared/conversation";
import type { StreamDeltaPosition } from "@/shared/stream-position";
import { createTimestamp } from "@/shared/events";
import { saveAutomationRun } from "../persistence/automations";
import { automationEventEmitter } from "./event-emitter";
import { MAX_PERSISTED_LOGS } from "./conversation-limits";

const MAX_OUTPUT_ENTRY_LENGTH = 16_384;

export type DeterministicOutputStream = "stdout" | "stderr";

export interface DeterministicAutomationOutputDetails {
  stream: DeterministicOutputStream;
}

export interface DeterministicAutomationOutputOptions {
  persist?: boolean;
  emit?: boolean;
  userId?: string;
  eventAutomationRunId?: string;
  onAppend?: (entry: ConversationLogEntry) => StreamDeltaPosition | void;
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

export class DeterministicAutomationOutput {
  private currentRun: AutomationRun;
  private persistenceQueue = Promise.resolve();
  private persistenceError: unknown;
  private readonly persist: boolean;
  private readonly emit: boolean;
  private readonly userId?: string;
  private readonly eventAutomationRunId?: string;
  private readonly onAppend?: (entry: ConversationLogEntry) => StreamDeltaPosition | void;

  constructor(run: AutomationRun, options: DeterministicAutomationOutputOptions = {}) {
    this.currentRun = run;
    this.persist = options.persist ?? true;
    this.emit = options.emit ?? true;
    this.userId = options.userId;
    this.eventAutomationRunId = options.eventAutomationRunId;
    this.onAppend = options.onAppend;
  }

  get run(): AutomationRun {
    return this.currentRun;
  }

  append(stream: DeterministicOutputStream, text: string): void {
    if (text.length === 0) {
      return;
    }

    const normalized = normalizeOutput(text);
    const timestamp = createTimestamp();
    const entry: ConversationLogEntry = {
      id: crypto.randomUUID(),
      level: stream === "stderr" ? "error" : "info",
      message: normalized.message,
      details: {
        stream,
        ...(normalized.truncated ? { truncated: true } : {}),
      } satisfies DeterministicAutomationOutputDetails & { truncated?: boolean },
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
    const streamPosition = this.onAppend?.(entry);
    if (this.emit) {
      automationEventEmitter.emit(
        {
          type: "automation.run.log",
          automationId: this.currentRun.automationId,
          automationRunId: this.eventAutomationRunId ?? this.currentRun.id,
          log: entry,
          timestamp,
          ...(streamPosition ? { streamPosition } : {}),
        },
        this.userId ? { userId: this.userId } : undefined,
      );
    }

    if (this.persist) {
      const snapshot = this.currentRun;
      this.persistenceQueue = this.persistenceQueue
        .then(async () => {
          await saveAutomationRun(snapshot);
        })
        .catch((error) => {
          this.persistenceError ??= error;
        });
    }
  }

  async flush(): Promise<AutomationRun> {
    if (!this.persist) {
      return this.currentRun;
    }
    await this.persistenceQueue;
    if (this.persistenceError !== undefined) {
      throw new Error("Failed to persist deterministic automation output", {
        cause: this.persistenceError,
      });
    }
    return this.currentRun;
  }
}
