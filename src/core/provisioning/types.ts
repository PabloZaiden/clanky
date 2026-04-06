import type { AgentProvider, ProvisioningJob, ProvisioningJobMode, ProvisioningLogEntry } from "../../types";

export interface StartProvisioningJobOptions {
  name: string;
  sshServerId: string;
  repoUrl: string;
  basePath: string;
  devcontainerSubpath?: string;
  provider: AgentProvider;
  mode?: ProvisioningJobMode;
  password?: string;
  /** For rebuild/restart mode: directory on the host where the repo lives */
  targetDirectory?: string;
  /** For rebuild/restart mode: existing workspace ID */
  workspaceId?: string;
}

export interface ProvisioningJobRecord {
  job: ProvisioningJob;
  logs: ProvisioningLogEntry[];
  abortController: AbortController;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}
