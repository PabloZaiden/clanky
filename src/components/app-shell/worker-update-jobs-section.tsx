import { memo, useState } from "react";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import { ConfirmModal, DataList, DataListRow, Panel, useToast } from "@pablozaiden/webapp/web";
import { isWorkerUpdateJobTerminal, type WorkerUpdateJob } from "@/shared/worker-update";
import type { DismissAllWorkerUpdateJobsResult } from "../../hooks/useWorkerUpdateJobs";
import {
  Button,
  getWorkerUpdateStatusBadgeVariant,
  getWorkerUpdateStatusLabel,
  StatusBadge,
} from "../common";
import { getWorkerUpdateProgressLabel } from "../worker-update/presentation";

export const WorkerUpdateJobsSection = memo(function WorkerUpdateJobsSection({
  jobs,
  onNavigate,
  onDismissAll,
  dismissingAll,
}: {
  jobs: WorkerUpdateJob[];
  onNavigate: (route: WebAppRoute) => void;
  onDismissAll: () => Promise<DismissAllWorkerUpdateJobsResult>;
  dismissingAll: boolean;
}) {
  const toast = useToast();
  const [dismissConfirmOpen, setDismissConfirmOpen] = useState(false);
  const hasTerminalJobs = jobs.some((job) => isWorkerUpdateJobTerminal(job.state.status));

  async function handleDismissAll(): Promise<void> {
    try {
      const result = await onDismissAll();
      setDismissConfirmOpen(false);
      const message = `Dismissed ${result.dismissedJobIds.length} worker update job${
        result.dismissedJobIds.length === 1 ? "" : "s"
      }`;
      if (result.failedJobIds.length > 0) {
        toast.error(`${message}, but ${result.failedJobIds.length} could not be dismissed.`);
      } else {
        toast.success(`${message}.`);
      }
    } catch (error) {
      toast.error(String(error));
    }
  }

  if (jobs.length === 0) {
    return null;
  }
  return (
    <>
      <Panel
        title="Worker updates"
        actions={hasTerminalJobs ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-red-600 dark:text-red-400"
            loading={dismissingAll}
            onClick={() => setDismissConfirmOpen(true)}
          >
            Dismiss all
          </Button>
        ) : null}
      >
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
      <ConfirmModal
        isOpen={dismissConfirmOpen}
        onClose={() => {
          if (!dismissingAll) {
            setDismissConfirmOpen(false);
          }
        }}
        onConfirm={() => void handleDismissAll()}
        title="Dismiss terminal worker update jobs?"
        message="This permanently removes all completed, failed, and interrupted worker update jobs and their logs. Pending and running jobs are kept."
        confirmLabel="Dismiss all"
        loading={dismissingAll}
        variant="danger"
      />
    </>
  );
});
