/**
 * Terminal-state task purge panel within workspace settings.
 */

import { useState } from "react";
import { ConfirmModal } from "@pablozaiden/webapp/web";
import { Button, Badge } from "../common";
import type { PurgeArchivedTasksResult } from "../../hooks";
import type { Workspace } from "@/shared/workspace";
import { TrashIcon } from "./icons";

interface PurgeTasksSectionProps {
  workspace: Workspace;
  onPurgeArchivedTasks: () => Promise<PurgeArchivedTasksResult>;
  purgeableTaskCount: number;
  purgingPurgeableTasks: boolean;
}

export function PurgeTasksSection({
  workspace,
  onPurgeArchivedTasks,
  purgeableTaskCount,
  purgingPurgeableTasks,
}: PurgeTasksSectionProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [purgeResult, setPurgeResult] = useState<PurgeArchivedTasksResult | null>(null);
  const [purgeError, setPurgeError] = useState<string | null>(null);

  async function handlePurge() {
    setPurgeResult(null);
    setPurgeError(null);
    try {
      const result = await onPurgeArchivedTasks();
      if (!result.success) {
        setShowConfirm(false);
        setPurgeError("Failed to purge terminal-state tasks.");
        return;
      }

      setPurgeResult(result);
      setShowConfirm(false);
    } catch (error) {
      setShowConfirm(false);
      setPurgeError(`Failed to purge terminal-state tasks: ${String(error)}`);
    }
  }

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 pt-6 mt-6">
      <div className="p-4 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-900/20">
        <div className="flex items-center justify-between gap-3 mb-2">
          <h3 className="text-sm font-medium text-red-800 dark:text-red-200">
            Tasks in a Terminal State
          </h3>
          <Badge variant={purgeableTaskCount > 0 ? "warning" : "default"} size="sm">
            {purgeableTaskCount} purgeable
          </Badge>
        </div>
        {purgeError && (
          <div className="mb-3 p-3 rounded-md bg-red-100 dark:bg-red-950/40 border border-red-200 dark:border-red-900">
            <p className="text-sm text-red-700 dark:text-red-300">{purgeError}</p>
          </div>
        )}

        {purgeResult && (
          <div className={`mb-3 p-3 rounded-md border ${
            purgeResult.failures.length > 0
              ? "bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-900"
              : "bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-900"
          }`}>
            <p className={`text-sm ${
              purgeResult.failures.length > 0
                ? "text-amber-700 dark:text-amber-300"
                : "text-green-700 dark:text-green-300"
            }`}>
              {purgeResult.totalArchived === 0
                ? "No tasks in a terminal state were found for this workspace."
                : purgeResult.failures.length > 0
                  ? `Purged ${purgeResult.purgedCount} of ${purgeResult.totalArchived} terminal-state tasks.`
                  : `Purged ${purgeResult.purgedCount} terminal-state tasks.`}
            </p>
            {purgeResult.failures.length > 0 && (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                Failed task IDs: {purgeResult.failures.map((failure) => failure.taskId).join(", ")}
              </p>
            )}
          </div>
        )}

        <Button
          type="button"
          variant="danger"
          size="sm"
          onClick={() => setShowConfirm(true)}
          disabled={purgingPurgeableTasks || purgeableTaskCount === 0}
          loading={purgingPurgeableTasks}
        >
          <TrashIcon className="w-4 h-4 mr-2" />
          Purge Terminal-State Tasks
        </Button>
      </div>

      <ConfirmModal
        isOpen={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={handlePurge}
        title="Purge Terminal-State Tasks"
        message={`Are you sure you want to permanently delete all ${purgeableTaskCount} tasks in a terminal state for "${workspace.name}"? This currently applies to merged, pushed, and deleted tasks and cannot be undone.`}
        confirmLabel="Purge All"
        loading={purgingPurgeableTasks}
        variant="danger"
      />
    </div>
  );
}
