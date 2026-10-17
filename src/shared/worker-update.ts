export type WorkerUpdateJobStatus =
  | "pending"
  | "connecting"
  | "running"
  | "verifying"
  | "completed"
  | "not_started"
  | "connection_failed"
  | "failed"
  | "interrupted"
  | "unconfirmed";

export type WorkerUpdateStep = "update" | "restart";

export type WorkerUpdateStepStatus =
  | "pending"
  | "connecting"
  | "running"
  | "verifying"
  | "succeeded"
  | "not_started"
  | "connection_failed"
  | "failed"
  | "interrupted"
  | "skipped"
  | "unconfirmed";

export interface WorkerUpdateStepResult {
  status: WorkerUpdateStepStatus;
  execution?: CommandExecutionState;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number;
  error?: string;
}

export interface WorkerUpdateJobError {
  code: string;
  message: string;
  step?: WorkerUpdateStep;
}

export interface WorkerUpdateJobConfig {
  id: string;
  workerNodeId: string;
  workerName: string;
  createdAt: string;
}

export interface WorkerUpdateJobState {
  status: WorkerUpdateJobStatus;
  currentStep: WorkerUpdateStep | null;
  steps: Record<WorkerUpdateStep, WorkerUpdateStepResult>;
  error?: WorkerUpdateJobError;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface WorkerUpdateJob {
  config: WorkerUpdateJobConfig;
  state: WorkerUpdateJobState;
}

export type WorkerUpdateLogSource = "stdout" | "stderr" | "system";

export interface WorkerUpdateLogEntry {
  id: string;
  source: WorkerUpdateLogSource;
  text: string;
  timestamp: string;
  step?: WorkerUpdateStep;
}

export interface WorkerUpdateJobSnapshot {
  job: WorkerUpdateJob;
  logs: WorkerUpdateLogEntry[];
}

export type WorkerUpdateEvent =
  | {
      type: "worker-update.changed";
      workerUpdateJobId: string;
      timestamp: string;
    }
  | {
      type: "worker-update.deleted";
      workerUpdateJobId: string;
      timestamp: string;
    };

export function isWorkerUpdateJobTerminal(
  status: WorkerUpdateJobStatus,
): boolean {
  return status === "completed"
    || status === "not_started"
    || status === "connection_failed"
    || status === "failed"
    || status === "interrupted"
    || status === "unconfirmed";
}
import type { CommandExecutionState } from "./job-execution";
