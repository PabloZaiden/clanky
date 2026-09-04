import type {
  AgentProvider,
  ExecutionHostRef,
  ProvisioningJob,
  ProvisioningJobMode,
  ProvisioningLogEntry,
} from "@/shared";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";

export interface StartProvisioningJobOptions {
  name: string;
  sshServerId?: string;
  executionNodeId?: string;
  executionHost?: ExecutionHostRef;
  repoUrl?: string;
  basePath: string;
  devcontainerSubpath?: string;
  devboxTemplate?: string;
  githubUser?: string;
  provider: AgentProvider;
  mode?: ProvisioningJobMode;
  createNewRepository?: boolean;
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
  owner: CurrentUser;
  runnerActive: boolean;
  secretValues: string[];
}
