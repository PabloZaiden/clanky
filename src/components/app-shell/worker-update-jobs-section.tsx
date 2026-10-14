import { memo } from "react";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import { DataList, DataListRow, Panel } from "@pablozaiden/webapp/web";
import type { WorkerUpdateJob } from "@/shared/worker-update";
import {
  getWorkerUpdateStatusBadgeVariant,
  getWorkerUpdateStatusLabel,
  StatusBadge,
} from "../common";
import { getWorkerUpdateProgressLabel } from "../worker-update/presentation";

export const WorkerUpdateJobsSection = memo(function WorkerUpdateJobsSection({
  jobs,
  onNavigate,
}: {
  jobs: WorkerUpdateJob[];
  onNavigate: (route: WebAppRoute) => void;
}) {
  if (jobs.length === 0) {
    return null;
  }
  return (
    <Panel title="Worker updates">
      <DataList>
        {jobs.map((job) => (
          <DataListRow
            key={job.config.id}
            title={job.config.workerName}
            description={getWorkerUpdateProgressLabel(job)}
            meta={new Intl.DateTimeFormat(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(job.state.updatedAt))}
            metaPlacement="below"
            badge={(
              <StatusBadge variant={getWorkerUpdateStatusBadgeVariant(job.state.status)}>
                {getWorkerUpdateStatusLabel(job.state.status)}
              </StatusBadge>
            )}
            onClick={() => onNavigate({
              view: "worker-update-job",
              workerUpdateJobId: job.config.id,
            })}
          />
        ))}
      </DataList>
    </Panel>
  );
});
