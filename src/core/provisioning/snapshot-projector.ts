import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import type {
  ProvisioningJobSnapshot,
} from "@/shared";
import { getWorkspace } from "../../persistence/workspaces";
import { loadProvisioningJob } from "../../persistence/provisioning-jobs";
import { ProvisioningAttempt } from "./attempt";
import { inferProvisioningTargetOwnership } from "./target-resolver";
import type { ProvisioningJobRecord } from "./types";

export class ProvisioningSnapshotProjector {
  constructor(
    private readonly maxLogEntries: number,
  ) {}

  async project(record: ProvisioningJobRecord): Promise<ProvisioningJobSnapshot> {
    const workspace = record.job.state.workspaceId
      ? await getWorkspace(record.job.state.workspaceId)
      : null;
    return {
      job: structuredClone(record.job),
      logs: [...record.logs],
      ...(workspace ? { workspace } : {}),
    };
  }

  hydrateRecord(
    owner: CurrentUser,
    jobId: string,
  ): ProvisioningJobRecord | null {
    const persisted = loadProvisioningJob(owner.id, jobId);
    if (!persisted) {
      return null;
    }

    const record: ProvisioningJobRecord = {
      job: persisted.job,
      logs: persisted.logs,
      abortController: new AbortController(),
      owner,
      runnerActive: false,
      secretValues: [],
      targetOwnership: inferProvisioningTargetOwnership(persisted.job.config),
    };
    record.attempt = new ProvisioningAttempt({
      record,
      maxLogEntries: this.maxLogEntries,
    });
    return record;
  }
}
