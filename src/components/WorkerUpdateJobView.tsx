import { memo } from "react";
import type { WorkerUpdateJobSnapshot } from "@/shared/worker-update";
import {
  DataList,
  ErrorState,
  LoadingState,
  Panel,
} from "@pablozaiden/webapp/web";
import {
  getWorkerUpdateStatusBadgeVariant,
  getWorkerUpdateStatusLabel,
  getWorkerUpdateStepStatusBadgeVariant,
  getWorkerUpdateStepStatusLabel,
} from "./common";
import { getWorkerUpdateStepLabel, getWorkerUpdateWorkerName } from "./worker-update/presentation";
import { ConsoleOutput } from "./console-output";
import { JobListRow } from "./job-list-row";

const WORKER_UPDATE_STEPS = ["update", "restart"] as const;

export interface WorkerUpdateJobViewProps {
  snapshot: WorkerUpdateJobSnapshot | null;
  loading?: boolean;
  error?: string | null;
}

export const WorkerUpdateJobView = memo(function WorkerUpdateJobView({
  snapshot,
  loading = false,
  error = null,
}: WorkerUpdateJobViewProps) {
  if (loading && !snapshot) {
    return <LoadingState title="Loading worker update job" />;
  }
  if (!snapshot) {
    return (
      <ErrorState
        title={error ? "Unable to load worker update job" : "Worker update job not found"}
        description={error ?? "The selected worker update job is no longer available."}
      />
    );
  }

  const { job } = snapshot;
  return (
    <div className="space-y-4">
      {error ? <ErrorState title="Unable to refresh job" description={error} /> : null}
      <DataList><JobListRow title={getWorkerUpdateWorkerName(job)}
        timestamp={job.state.updatedAt} status={getWorkerUpdateStatusLabel(job.state.status)}
        statusVariant={getWorkerUpdateStatusBadgeVariant(job.state.status)} /></DataList>

      {job.state.error ? (
        <ErrorState title="Job error" description={job.state.error.message} />
      ) : null}

      <Panel title="Progress">
        <DataList>
          {WORKER_UPDATE_STEPS.map((step) => {
            const result = job.state.steps[step];
            return (
              <JobListRow
                key={step}
                title={getWorkerUpdateStepLabel(step)}
                description={job.state.error?.step === step
                  ? undefined : result.error}
                timestamp={result.completedAt ?? result.startedAt}
                exitCode={result.exitCode}
                status={getWorkerUpdateStepStatusLabel(result.status)}
                statusVariant={getWorkerUpdateStepStatusBadgeVariant(result.status)}
              />
            );
          })}
        </DataList>
      </Panel>

      <Panel title="Logs" description={`${String(snapshot.logs.length)} entries`}>
        <ConsoleOutput entries={snapshot.logs} />
      </Panel>
    </div>
  );
});
