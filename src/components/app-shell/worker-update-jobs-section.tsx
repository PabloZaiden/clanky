import { memo, useState } from "react";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import { ConfirmModal, DataList, Panel, useToast } from "@pablozaiden/webapp/web";
import { isWorkerUpdateJobTerminal, type WorkerUpdateJob } from "@/shared/worker-update";
import type { DismissAllWorkerUpdateJobsResult } from "../../hooks/useWorkerUpdateJobs";
import {
  Button,
  getWorkerUpdateStatusBadgeVariant,
  getWorkerUpdateStatusLabel,
} from "../common";
import { getWorkerUpdateWorkerName } from "../worker-update/presentation";
import { JobListRow } from "../job-list-row";

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
            tone="danger"
            loading={dismissingAll}
            onClick={() => setDismissConfirmOpen(true)}
          >
            Dismiss all
          </Button>
        ) : null}
      >
        <DataList>
          {jobs.map((job) => (
            <JobListRow
              key={job.config.id}
              title={getWorkerUpdateWorkerName(job)}
              timestamp={job.state.updatedAt}
              status={getWorkerUpdateStatusLabel(job.state.status)}
              statusVariant={getWorkerUpdateStatusBadgeVariant(job.state.status)}
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
        message="Permanently delete finished worker update jobs and their logs?"
        confirmLabel="Dismiss all"
        loading={dismissingAll}
        variant="danger"
      />
    </>
  );
});
