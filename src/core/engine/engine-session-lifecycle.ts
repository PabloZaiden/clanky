/**
 * Backend connection and ACP session ownership for TaskEngine.
 */

import type { TaskConfig, TaskState } from "@/shared/task";
import type { LogLevel } from "@/shared/events";
import type {
  SessionInterruptOptions,
  SessionReconnectResult,
  TaskBackend,
  TaskSessionLifecycle,
} from "./engine-types";
import {
  handleModelChange,
  reconnectTaskSession,
  recreateSessionAfterLoss,
  setupTaskSession,
  type SessionOperationContext,
} from "./engine-session";

export interface TaskSessionLifecycleOptions {
  backend: TaskBackend;
  config: TaskConfig;
  state: TaskState;
  getWorkingDirectory: () => string;
  emitLog: (level: LogLevel, message: string, details?: Record<string, unknown>) => string;
  updateState: (update: Partial<TaskState>) => void;
}

/**
 * Owns the backend connection, active session identity, and session-level
 * interruption/recovery state without owning task iteration decisions.
 */
export class TaskSessionLifecycleImpl implements TaskSessionLifecycle {
  private readonly backend: TaskBackend;
  private readonly config: TaskConfig;
  private readonly state: TaskState;
  private readonly getWorkingDirectory: () => string;
  private readonly emitLog: TaskSessionLifecycleOptions["emitLog"];
  private readonly updateState: TaskSessionLifecycleOptions["updateState"];
  private currentSessionId: string | null = null;
  private sessionRecoveryPending = false;
  private activeInterrupt: Promise<void> | null = null;

  constructor(options: TaskSessionLifecycleOptions) {
    this.backend = options.backend;
    this.config = options.config;
    this.state = options.state;
    this.getWorkingDirectory = options.getWorkingDirectory;
    this.emitLog = options.emitLog;
    this.updateState = options.updateState;
  }

  get sessionId(): string | null {
    return this.currentSessionId;
  }

  isConnected(): boolean {
    return this.backend.isConnected();
  }

  async waitForInterrupt(): Promise<void> {
    await this.activeInterrupt;
  }

  async setup(): Promise<string> {
    return setupTaskSession(this.makeContext());
  }

  async reconnect(): Promise<SessionReconnectResult> {
    const result = await reconnectTaskSession(this.makeContext());
    this.sessionRecoveryPending = result.createdNew;
    return result;
  }

  async ensureSession(): Promise<void> {
    if (this.currentSessionId && this.backend.isConnected()) {
      return;
    }
    await this.reconnect();
  }

  async recreateAfterLoss(reason: string): Promise<string> {
    const sessionId = await recreateSessionAfterLoss(this.makeContext(), reason);
    this.sessionRecoveryPending = true;
    return sessionId;
  }

  async handlePendingModelChange(): Promise<void> {
    await handleModelChange(this.makeContext());
  }

  consumeSessionRecovery(): boolean {
    const pending = this.sessionRecoveryPending;
    this.sessionRecoveryPending = false;
    return pending;
  }

  async interruptSession(options: SessionInterruptOptions): Promise<void> {
    await this.waitForInterrupt();

    if (!this.currentSessionId) {
      return;
    }

    const activeSessionId = this.currentSessionId;
    const interruptPromise = (async () => {
      try {
        this.emitLog("info", options.abortMessage);
        await this.backend.abortSession(activeSessionId);
      } catch (error) {
        this.emitLog("warn", options.abortWarnMessage, {
          error: String(error),
        });
      }

      if (!options.forceDisconnect) {
        return;
      }

      if (!this.backend.isConnected()) {
        this.currentSessionId = null;
        return;
      }

      try {
        this.emitLog(
          "info",
          options.disconnectMessage
            ?? "Disconnecting the backend to finish interrupting the active session",
        );
        await this.backend.disconnect();
      } catch (error) {
        this.emitLog(
          "warn",
          options.disconnectWarnMessage
            ?? "Failed to disconnect the backend after interrupting the active session",
          { error: String(error) },
        );
      } finally {
        this.currentSessionId = null;
      }
    })();

    let trackedInterrupt: Promise<void>;
    trackedInterrupt = interruptPromise.finally(() => {
      if (this.activeInterrupt === trackedInterrupt) {
        this.activeInterrupt = null;
      }
    });
    this.activeInterrupt = trackedInterrupt;
    await trackedInterrupt;
  }

  private makeContext(): SessionOperationContext {
    return {
      backend: this.backend,
      config: this.config,
      state: this.state,
      workingDirectory: this.getWorkingDirectory(),
      emitLog: this.emitLog,
      updateState: this.updateState,
      getSessionId: () => this.currentSessionId,
      setSessionId: (id: string | null) => {
        this.currentSessionId = id;
      },
    };
  }
}
