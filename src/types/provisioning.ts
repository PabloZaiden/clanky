/**
 * Provisioning job types for automatic workspace creation.
 */

import type { z } from "zod";
import { CreateProvisioningJobRequestSchema } from "./schemas/provisioning";
import type { AgentProvider, ServerSettings } from "./settings";
import type { Workspace } from "./workspace";

export type CreateProvisioningJobRequest = z.infer<typeof CreateProvisioningJobRequestSchema>;

export type ProvisioningJobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type ProvisioningJobMode = "provision" | "rebuild" | "restart";

export type ProvisioningStep =
  | "verify_devbox"
  | "prepare_directory"
  | "clone_repo"
  | "devbox_up"
  | "devbox_rebuild"
  | "devbox_status"
  | "create_workspace"
  | "test_connection"
  | "workspace_ready";

export type ProvisioningLogSource = "stdout" | "stderr" | "system";

export interface ProvisioningLogEntry {
  id: string;
  source: ProvisioningLogSource;
  text: string;
  timestamp: string;
  step?: ProvisioningStep;
}

export interface ProvisioningJobError {
  code: string;
  message: string;
  step?: ProvisioningStep;
}

export interface ProvisioningJobConfig {
  id: string;
  name: string;
  sshServerId: string;
  repoUrl: string;
  basePath: string;
  provider: AgentProvider;
  mode?: ProvisioningJobMode;
  /** For rebuild mode: directory where the repo lives on the host */
  targetDirectory?: string;
  /** For rebuild mode: existing workspace ID */
  workspaceId?: string;
  createdAt: string;
}

export interface ProvisioningJobState {
  status: ProvisioningJobStatus;
  currentStep?: ProvisioningStep;
  targetDirectory?: string;
  resolvedDirectory?: string;
  workspaceId?: string;
  workspaceAction?: "created" | "reused";
  serverSettings?: ServerSettings;
  error?: ProvisioningJobError;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface ProvisioningJob {
  config: ProvisioningJobConfig;
  state: ProvisioningJobState;
}

export interface ProvisioningJobSnapshot {
  job: ProvisioningJob;
  logs: ProvisioningLogEntry[];
  workspace?: Workspace;
}

export interface DevboxPublishedPort {
  hostIp: string;
  hostPort: number;
}

export interface DevboxStatusResult {
  running: boolean;
  port?: number | null;
  password?: string | null;
  workdir?: string | null;
  sshUser?: string | null;
  sshPort?: number | null;
  remoteUser?: string | null;
  hasCredentialFile?: boolean;
  credentialPath?: string | null;
  publishedPorts?: Record<string, DevboxPublishedPort[]>;
}

export interface ProvisioningStartedEvent {
  type: "provisioning.started";
  provisioningJobId: string;
  job: ProvisioningJob;
  timestamp: string;
}

export interface ProvisioningStepEvent {
  type: "provisioning.step";
  provisioningJobId: string;
  job: ProvisioningJob;
  step: ProvisioningStep;
  message?: string;
  timestamp: string;
}

export interface ProvisioningOutputEvent {
  type: "provisioning.output";
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

export type ProvisioningEvent =
  | ProvisioningStartedEvent
  | ProvisioningStepEvent
  | ProvisioningOutputEvent
  | ProvisioningCompletedEvent
  | ProvisioningFailedEvent
  | ProvisioningCancelledEvent;
