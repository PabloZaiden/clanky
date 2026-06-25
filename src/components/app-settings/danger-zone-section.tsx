import { useState } from "react";
import { Button } from "../common";
import type { PurgeTerminalTasksResult } from "../../hooks";

export interface DangerZoneSectionProps {
  onPurgeTerminalTasks?: () => Promise<PurgeTerminalTasksResult | null>;
  purgingTerminalTasks?: boolean;
}

export function DangerZoneSection({
  onPurgeTerminalTasks,
  purgingTerminalTasks = false,
}: DangerZoneSectionProps) {
  const [showPurgeConfirm, setShowPurgeConfirm] = useState(false);
  const [purgeResult, setPurgeResult] = useState<PurgeTerminalTasksResult | null>(null);
  const [purgeError, setPurgeError] = useState(false);

  if (!onPurgeTerminalTasks) return null;

  return (
    <div>
      <h3 className="mb-4 text-sm font-medium text-gray-900 dark:text-gray-100">
        Maintenance
      </h3>
      <div className="space-y-3 rounded-lg bg-gray-50 p-4 dark:bg-neutral-900">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Purge terminal-state tasks
            </h4>
            <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">
              Permanently delete archived terminal tasks across every workspace. Addressable pushed and accepted-local tasks are kept.
            </p>
          </div>
          {!showPurgeConfirm ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setPurgeResult(null);
                setPurgeError(false);
                setShowPurgeConfirm(true);
              }}
              disabled={purgingTerminalTasks}
            >
              Purge terminal-state tasks
            </Button>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-gray-500 dark:text-gray-400">Are you sure?</span>
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={async () => {
                  setPurgeError(false);
                  const result = await onPurgeTerminalTasks();
                  setShowPurgeConfirm(false);
                  if (result) {
                    setPurgeResult(result);
                  } else {
                    setPurgeError(true);
                  }
                }}
                loading={purgingTerminalTasks}
              >
                Yes, purge tasks
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowPurgeConfirm(false);
                  setPurgeError(false);
                }}
                disabled={purgingTerminalTasks}
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
        {purgeResult && (
          <div className={`rounded px-2 py-1 text-sm ${
            purgeResult.failures.length > 0
              ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
              : "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
          }`}>
            {purgeResult.totalArchived === 0
              ? "No terminal-state tasks were found across all workspaces."
              : purgeResult.failures.length > 0
                ? `Purged ${purgeResult.purgedCount} of ${purgeResult.totalArchived} terminal-state tasks across ${purgeResult.totalWorkspaces} workspaces.`
                : `Purged ${purgeResult.purgedCount} terminal-state tasks across ${purgeResult.totalWorkspaces} workspaces.`}
            {purgeResult.failures.length > 0 && (
              <div className="mt-1 text-xs">
                Failed task IDs: {purgeResult.failures.map((failure) => failure.taskId).join(", ")}
              </div>
            )}
          </div>
        )}
        {purgeError && (
          <div className="rounded bg-red-100 px-2 py-1 text-sm text-red-600 dark:bg-red-900/30 dark:text-red-400">
            Failed to purge terminal-state tasks. Please try again.
          </div>
        )}
      </div>
    </div>
  );
}
