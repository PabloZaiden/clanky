import { useState } from "react";
import { ConfirmModal, SettingsFieldRow, useToast } from "@pablozaiden/webapp/web";
import type { UseWorkerUpdateJobsResult } from "../../hooks/useWorkerUpdateJobs";
import { Button } from "../common";
import { SettingsError } from "./settings-row-controls";
import type { WorkerUpdateMode } from "@/shared/worker-update";
import { useWorkerUpdatePreferences } from "../../hooks/useWorkerUpdatePreferences";
import { WorkerChannelSelect } from "../worker-channel-select";

export function WorkerUpdateAction({
  workerUpdates,
}: {
  workerUpdates: UseWorkerUpdateJobsResult;
}) {
  const toast = useToast();
  const preferences = useWorkerUpdatePreferences({ enabled: workerUpdates.enabled });
  const [channel, setChannel] = useState<WorkerUpdateMode | undefined>();
  const [confirmedChannel, setConfirmedChannel] = useState<WorkerUpdateMode | null>(null);
  const selectedChannel = channel ?? preferences.data?.mode;
  const unavailable = !preferences.data || Boolean(preferences.error);

  async function startUpdates(): Promise<void> {
    if (confirmedChannel === null) return;
    const response = await workerUpdates.startUpdates(confirmedChannel);
    setConfirmedChannel(null);
    if (!response) {
      return;
    }
    await preferences.refresh();
    setChannel(undefined);

    const startedCount = response.results.filter((item) => item.status === "started").length;
    const alreadyActiveCount = response.results.filter((item) => item.status === "not_started").length;
    const failedResults = response.results.filter((item) => item.status === "failed");
    const failedCount = failedResults.length;

    if (response.totalWorkers === 0) {
      toast.info("No active Mesh workers were found.");
    } else if (failedCount > 0) {
      const alreadyActiveSummary = alreadyActiveCount > 0
        ? ` ${alreadyActiveCount} already have an active job.`
        : "";
      const failureDetails = failedResults
        .map(({ workerName, error }) => `${workerName}: ${error}`)
        .join("; ");
      toast.error(
        `Started update jobs for ${startedCount} of ${response.totalWorkers} workers.${alreadyActiveSummary} Failed workers (${failedCount}): ${failureDetails}`,
        { duration: 0 },
      );
    } else if (startedCount > 0) {
      const alreadyActiveSummary = alreadyActiveCount > 0
        ? ` ${alreadyActiveCount} already have an active job.`
        : "";
      toast.success(
        `Started update jobs for ${startedCount} workers.${alreadyActiveSummary}`,
      );
    } else {
      toast.info(
        `No new update jobs started; ${alreadyActiveCount} workers already have an active job.`,
      );
    }
  }

  return (
    <>
      <SettingsFieldRow title="Clanky workers" content={(
        <WorkerChannelSelect
          id="worker-update-channel"
          value={selectedChannel}
          onChange={setChannel}
          disabled={workerUpdates.starting || !workerUpdates.enabled || unavailable}
        />
      )} actions={<Button
          type="button"
          size="sm"
          loading={workerUpdates.starting}
          disabled={workerUpdates.starting || !workerUpdates.enabled || unavailable}
          onClick={() => selectedChannel && setConfirmedChannel(selectedChannel)}
        >
          Update all
        </Button>} feedback={<>

      {workerUpdates.error ? <SettingsError>{workerUpdates.error}</SettingsError> : null}
      {preferences.error ? <SettingsError>{String(preferences.error)}</SettingsError> : null}

      </>} />
      <ConfirmModal
        isOpen={confirmedChannel !== null}
        onClose={() => {
          if (!workerUpdates.starting) {
            setConfirmedChannel(null);
          }
        }}
        onConfirm={() => void startUpdates()}
        title="Update Clanky on all workers?"
        message={confirmedChannel === "default"
          ? "Update all enrolled server and automatic workspace workers using each worker's saved channel. Workers restart after successful updates; active connections may close."
          : `Permanently switch all enrolled workers to ${confirmedChannel === "latest" ? "Latest" : "Stable"} and use it by default for new automatic workspaces. ${confirmedChannel === "stable" ? "Latest builds may be downgraded. " : ""}Workers restart after successful updates; active connections may close.`}
        confirmLabel="Update workers"
        loading={workerUpdates.starting}
      />
    </>
  );
}
