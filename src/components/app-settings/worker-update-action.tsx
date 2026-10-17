import { useState } from "react";
import { ConfirmModal, SettingsFieldRow } from "@pablozaiden/webapp/web";
import type { StartWorkerUpdatesResponse } from "@/contracts";
import type { UseWorkerUpdateJobsResult } from "../../hooks/useWorkerUpdateJobs";
import { Button } from "../common";
import { SettingsError } from "./settings-row-controls";

export function WorkerUpdateAction({
  workerUpdates,
}: {
  workerUpdates: UseWorkerUpdateJobsResult;
}) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [result, setResult] = useState<StartWorkerUpdatesResponse | null>(null);
  const startedCount = result?.results.filter((item) => item.status === "started").length ?? 0;
  const alreadyActiveCount = result?.results.filter((item) => item.status === "not_started").length ?? 0;
  const hasFailures = result?.results.some((item) => item.status === "failed") ?? false;

  async function startUpdates(): Promise<void> {
    const response = await workerUpdates.startUpdates();
    setShowConfirm(false);
    if (response) {
      setResult(response);
    }
  }

  return (
    <>
      <SettingsFieldRow title="Global workers" actions={<Button
          type="button"
          size="sm"
          loading={workerUpdates.starting}
          disabled={workerUpdates.starting || !workerUpdates.enabled}
          onClick={() => {
            setResult(null);
            setShowConfirm(true);
          }}
        >
          Update all
        </Button>} feedback={<>

      {workerUpdates.error ? <SettingsError>{workerUpdates.error}</SettingsError> : null}

      {result ? (
        <div
          role="status"
          className={`rounded-md border p-3 text-sm ${
            hasFailures
              ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
              : "border-gray-200 bg-gray-50 text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
          }`}
        >
          <p className="font-medium">
            {result.totalWorkers === 0
              ? "No active global Mesh workers were found."
              : `Started ${String(startedCount)} of ${String(result.totalWorkers)} worker update jobs.${
                  alreadyActiveCount > 0
                    ? ` ${String(alreadyActiveCount)} already have an active job.`
                    : ""
                }`}
          </p>
          {result.results.length > 0 ? (
            <ul className="mt-2 space-y-1 text-xs">
              {result.results.map((item) => (
                <li key={item.workerNodeId}>
                  <span className="font-medium">{item.workerName}:</span>{" "}
                  {item.status === "started"
                    ? "Update requested"
                    : item.status === "not_started"
                      ? `Not started · ${item.message}`
                      : `Not started · ${item.error}`}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
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
