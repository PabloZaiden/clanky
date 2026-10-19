import { useState } from "react";
import { ConfirmModal, SettingsFieldRow, useToast } from "@pablozaiden/webapp/web";
import type { UseWorkerUpdateJobsResult } from "../../hooks/useWorkerUpdateJobs";
import { Button } from "../common";
import { SettingsError } from "./settings-row-controls";

export function WorkerUpdateAction({
  workerUpdates,
}: {
  workerUpdates: UseWorkerUpdateJobsResult;
}) {
  const toast = useToast();
  const [showConfirm, setShowConfirm] = useState(false);

  async function startUpdates(): Promise<void> {
    const response = await workerUpdates.startUpdates();
    setShowConfirm(false);
    if (!response) {
      return;
    }

    const startedCount = response.results.filter((item) => item.status === "started").length;
    const alreadyActiveCount = response.results.filter((item) => item.status === "not_started").length;
    const failedResults = response.results.filter((item) => item.status === "failed");
    const failedCount = failedResults.length;

    if (response.totalWorkers === 0) {
      toast.info("No active global Mesh workers were found.");
    } else if (failedCount > 0) {
      const alreadyActiveSummary = alreadyActiveCount > 0
        ? ` ${alreadyActiveCount} already have an active job.`
        : "";
      const failureDetails = failedResults
        .map(({ workerName, error }) => `${workerName}: ${error}`)
        .join("; ");
      toast.error(
        `Started update jobs for ${startedCount} of ${response.totalWorkers} global workers.${alreadyActiveSummary} Failed workers (${failedCount}): ${failureDetails}`,
        { duration: 0 },
      );
    } else if (startedCount > 0) {
      const alreadyActiveSummary = alreadyActiveCount > 0
        ? ` ${alreadyActiveCount} already have an active job.`
        : "";
      toast.success(
        `Started update jobs for ${startedCount} global workers.${alreadyActiveSummary}`,
      );
    } else {
      toast.info(
        `No new update jobs started; ${alreadyActiveCount} global workers already have an active job.`,
      );
    }
  }

  return (
    <>
      <SettingsFieldRow title="Global workers" actions={<Button
          type="button"
          size="sm"
          loading={workerUpdates.starting}
          disabled={workerUpdates.starting || !workerUpdates.enabled}
          onClick={() => setShowConfirm(true)}
        >
          Update all
        </Button>} feedback={<>

      {workerUpdates.error ? <SettingsError>{workerUpdates.error}</SettingsError> : null}

      </>} />
      <ConfirmModal
        isOpen={showConfirm}
        onClose={() => {
          if (!workerUpdates.starting) {
            setShowConfirm(false);
          }
        }}
        onConfirm={() => void startUpdates()}
        title="Update all global Mesh workers?"
        message="Update all global workers? Their services restart after a successful update. Active connections may close."
        confirmLabel="Update workers"
        loading={workerUpdates.starting}
      />
    </>
  );
}
