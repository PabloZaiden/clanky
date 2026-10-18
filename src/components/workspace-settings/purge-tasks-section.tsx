/**
 * Confirmed cleanup of workspace tasks in terminal states.
 */

import { useState } from "react";
import { Button, ConfirmModal, SettingsFieldRow, useToast } from "@pablozaiden/webapp/web";
import type { PurgeArchivedTasksResult } from "../../hooks";
import type { Workspace } from "@/shared/workspace";

interface PurgeTasksSectionProps {
  workspace: Workspace;
  onPurgeArchivedTasks: () => Promise<PurgeArchivedTasksResult>;
  purgeableTaskCount: number;
  purgingPurgeableTasks: boolean;
}

export function PurgeTasksSection({
  workspace, onPurgeArchivedTasks, purgeableTaskCount, purgingPurgeableTasks,
}: PurgeTasksSectionProps) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePurge(): Promise<void> {
    setError(null);
    try {
      const result = await onPurgeArchivedTasks();
      setConfirming(false);
      if (!result.success) {
        setError("Unable to purge completed tasks. Try again.");
      } else if (result.failures.length) {
        setError(`Purged ${result.purgedCount} of ${result.totalArchived} tasks. ${result.failures.length} could not be removed; retry to finish.`);
      } else {
        toast.success(`Purged ${result.purgedCount} tasks.`);
      }
    } catch (cause) {
      setConfirming(false);
      setError(`Unable to purge completed tasks: ${String(cause)}`);
    }
  }

  return <>
    <SettingsFieldRow title="Completed tasks" danger
      description="Permanently remove merged, pushed and deleted tasks."
      feedback={error ? <span role="alert" className="text-red-600 dark:text-red-400">{error}</span> : `${purgeableTaskCount} available`}
      actions={<Button tone="danger" loading={purgingPurgeableTasks} disabled={purgeableTaskCount === 0}
        onClick={() => setConfirming(true)}>Purge</Button>} />
    <ConfirmModal isOpen={confirming} onClose={() => setConfirming(false)} onConfirm={handlePurge}
      title="Purge completed tasks" confirmLabel="Purge tasks" loading={purgingPurgeableTasks} variant="danger"
      message={`Permanently delete ${purgeableTaskCount} merged, pushed or deleted tasks from "${workspace.name}"? This cannot be undone.`} />
  </>;
}
