import { memo, useEffect, useRef } from "react";
import type { WorkerUpdateJobSnapshot } from "@/shared/worker-update";
import {
  DataList,
  DataListRow,
  ErrorState,
  LoadingState,
  Panel,
} from "@pablozaiden/webapp/web";
import {
  getWorkerUpdateStatusBadgeVariant,
  getWorkerUpdateStatusLabel,
  getWorkerUpdateStepStatusBadgeVariant,
  getWorkerUpdateStepStatusLabel,
  StatusBadge,
} from "./common";
import { getWorkerUpdateStepLabel } from "./worker-update/presentation";

const WORKER_UPDATE_STEPS = ["update", "restart"] as const;

function formatTimestamp(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

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
  const logContainerRef = useRef<HTMLDivElement>(null);
  const logs = snapshot?.logs;

  useEffect(() => {
    const container = logContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [logs]);

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
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge variant={getWorkerUpdateStatusBadgeVariant(job.state.status)}>
          {getWorkerUpdateStatusLabel(job.state.status)}
        </StatusBadge>
        <span className="text-sm text-gray-600 dark:text-gray-300">
          {job.config.workerName}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          Updated {formatTimestamp(job.state.updatedAt)}
        </span>
      </div>

      {job.state.error ? (
        <ErrorState title="Job error" description={job.state.error.message} />
      ) : null}

      <Panel title="Progress">
        <DataList>
          {WORKER_UPDATE_STEPS.map((step) => {
            const result = job.state.steps[step];
            const timestamp = formatTimestamp(result.completedAt ?? result.startedAt);
            return (
              <DataListRow
                key={step}
                title={getWorkerUpdateStepLabel(step)}
                description={result.error ?? getWorkerUpdateStepStatusLabel(result.status)}
                descriptionClassName={result.error ? "line-clamp-2" : "truncate"}
                metaPlacement="below"
                meta={result.exitCode === undefined
                  ? timestamp
                  : `Exit code ${String(result.exitCode)}${timestamp ? ` · ${timestamp}` : ""}`}
                badge={(
                  <StatusBadge variant={getWorkerUpdateStepStatusBadgeVariant(result.status)}>
                    {getWorkerUpdateStepStatusLabel(result.status)}
                  </StatusBadge>
                )}
              />
            );
          })}
        </DataList>
      </Panel>

      <Panel title="Logs" description={`${String(snapshot.logs.length)} entries`}>
        <div
          ref={logContainerRef}
          className="max-h-80 overflow-auto rounded-md border border-gray-200 bg-neutral-950 p-3 font-mono text-xs text-gray-100 dark:border-gray-700"
        >
          {snapshot.logs.length === 0 ? (
            <div className="text-gray-400">Waiting for command output.</div>
          ) : (
            snapshot.logs.map((entry) => (
              <div key={entry.id} className="whitespace-pre-wrap break-words">
                <span className="mr-2 text-gray-500">
                  [{entry.source}{entry.step ? ` · ${entry.step}` : ""}]
                </span>
                <span>{entry.text}</span>
              </div>
            ))
          )}
        </div>
      </Panel>
    </div>
  );
});
