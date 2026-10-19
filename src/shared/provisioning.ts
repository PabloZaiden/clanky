/**
 * Provisioning job types for automatic workspace creation.
 */

import type { AgentProvider, HarnessAdapter, ServerSettings } from "./settings";
import type { PublicServerSettings, PublicWorkspace, Workspace } from "./workspace";
import type { ExecutionHostBinding } from "./execution-host";
import type { CommandExecutionState } from "./job-execution";
import type { StreamDeltaPosition, StreamPosition } from "./stream-position";

export type ProvisioningJobStatus =
  | "pending"
  | "running"
  | "verifying"
  | "completed"
  | "not_started"
  | "connection_failed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unconfirmed";

export function isProvisioningJobTerminal(status: ProvisioningJobStatus): boolean {
  return status === "completed"
    || status === "not_started"
    || status === "connection_failed"
    || status === "failed"
    || status === "cancelled"
    || status === "interrupted"
    || status === "unconfirmed";
}

export function canRetryProvisioningJob(job: ProvisioningJob | PublicProvisioningJob): boolean {
  return job.config.mode === "provision"
    && isProvisioningJobTerminal(job.state.status)
    && job.state.status !== "completed"
    && job.state.status !== "unconfirmed"
    && job.state.execution?.outcome !== "unconfirmed";
}

export type ProvisioningJobMode = "provision" | "rebuild" | "restart" | "arise";
export type ProvisioningTransport = "ssh" | "worker";
export const PROVISIONING_WORKER_ENROLLMENT_ROUTES = ["direct", "relay"] as const;
export type ProvisioningWorkerEnrollmentRoute =
  typeof PROVISIONING_WORKER_ENROLLMENT_ROUTES[number];

export type ProvisioningStep =
  | "verify_devbox"
  | "prepare_directory"
  | "clone_repo"
  | "devbox_up"
  | "devbox_rebuild"
  | "devbox_arise"
  | "devbox_status"
  | "create_workspace"
  | "test_connection"
  | "workspace_ready"
  | "arise_complete";

export type ProvisioningLogSource = "stdout" | "stderr" | "system";

export interface ProvisioningLogEntry {
  id: string;
  source: ProvisioningLogSource;
  text: string;
  timestamp: string;
  step?: ProvisioningStep;
}

export interface ProvisioningCleanupError {
  resource: string;
  message: string;
}

export interface ProvisioningJobError {
  code: string;
  message: string;
  step?: ProvisioningStep;
}

export interface ProvisioningCommandExecution {
  step: ProvisioningStep;
  state: CommandExecutionState;
  outcome?: "succeeded" | "failed" | "interrupted" | "unconfirmed";
  exitCode?: number;
}

export interface ProvisioningJobConfig {
  id: string;
  name: string;
  executionHostBinding: ExecutionHostBinding;
  transport?: ProvisioningTransport;
  workspaceWorkerEnrollmentId?: string;
  workerEnrollmentId?: string;
  workerEnrollmentRoute?: ProvisioningWorkerEnrollmentRoute;
  workerRelayName?: string;
  workerHostAddress?: string;
  workerHostAddressManual?: boolean;
  repoUrl?: string;
  basePath: string;
  devcontainerSubpath?: string;
  devboxTemplate?: string;
  githubUser?: string;
  provider: AgentProvider;
  adapter?: HarnessAdapter;
  mode?: ProvisioningJobMode;
  createNewRepository?: boolean;
  /** For rebuild/restart mode: directory where the repo lives on the host */
  targetDirectory?: string;
  /** For rebuild/restart mode: existing workspace ID */
  workspaceId?: string;
  /** Install the latest Clanky prerelease in an automatic worker launcher */
  useClankyPrerelease?: boolean;
  createdAt: string;
}

export interface ProvisioningJobState {
  status: ProvisioningJobStatus;
  /** Cumulative dispatch evidence; absent on legacy records. */
  hasDispatchedCommands?: boolean;
  execution?: ProvisioningCommandExecution;
  recovery?: {
    step: ProvisioningStep;
    status: "verifying" | "confirmed" | "unconfirmed";
  };
  currentStep?: ProvisioningStep;
  targetDirectory?: string;
  resolvedDirectory?: string;
  workspaceId?: string;
  workspaceAction?: "created" | "reused";
  serverSettings?: ServerSettings;
  error?: ProvisioningJobError;
  cleanupErrors?: ProvisioningCleanupError[];
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface PublicProvisioningJobState extends Omit<ProvisioningJobState, "serverSettings"> {
  serverSettings?: PublicServerSettings;
}

export interface ProvisioningJob {
  config: ProvisioningJobConfig;
  state: ProvisioningJobState;
}

export interface PublicProvisioningJob extends Omit<ProvisioningJob, "state"> {
  state: PublicProvisioningJobState;
}

export interface ProvisioningJobSnapshot {
  position: StreamPosition;
  job: ProvisioningJob;
  logs: ProvisioningLogEntry[];
  workspace?: Workspace;
}

export interface PublicProvisioningJobSnapshot extends Omit<ProvisioningJobSnapshot, "job" | "workspace"> {
  job: PublicProvisioningJob;
  workspace?: PublicWorkspace;
}

export interface DevboxPublishedPort {
  hostIp: string | null;
  hostPort: number | null;
}

export interface DevboxStatusResult {
  running: boolean;
  ports: number[];
  sshEnabled: boolean;
  password: string | null;
  workdir: string;
  sshUser: string | null;
  sshPort: number | null;
  remoteUser: string | null;
  hasCredentialFile: boolean;
  credentialPath: string;
  publishedPorts: Record<string, DevboxPublishedPort[]>;
}

export interface ProvisioningStartedEvent {
  type: "provisioning.started";
  provisioningJobId: string;
  job: ProvisioningJob;
  timestamp: string;
}

export interface ProvisioningStepEvent {
  type: "provisioning.step";
  streamPosition: StreamDeltaPosition;
  provisioningJobId: string;
  job: ProvisioningJob;
  step: ProvisioningStep;
  message?: string;
  timestamp: string;
}

export interface ProvisioningOutputEvent {
  type: "provisioning.output";
  streamPosition: StreamDeltaPosition;
  provisioningJobId: string;
  entry: ProvisioningLogEntry;
  timestamp: string;
}

export interface ProvisioningCompletedEvent {
  type: "provisioning.completed";
  provisioningJobId: string;
  job: ProvisioningJob;
  timestamp: string;
}

export interface ProvisioningFailedEvent {
  type: "provisioning.failed";
  provisioningJobId: string;
  job: ProvisioningJob;
  error: ProvisioningJobError;
  timestamp: string;
}

export interface ProvisioningCancelledEvent {
  type: "provisioning.cancelled";
  provisioningJobId: string;
  job: ProvisioningJob;
  timestamp: string;
}

export interface ProvisioningDismissedEvent {
  type: "provisioning.dismissed";
  provisioningJobId: string;
  timestamp: string;
}

export type ProvisioningEvent =
  | ProvisioningStartedEvent
  | ProvisioningStepEvent
  | ProvisioningOutputEvent
  | ProvisioningCompletedEvent
  | ProvisioningFailedEvent
  | ProvisioningCancelledEvent
  | ProvisioningDismissedEvent;
