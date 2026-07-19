import { useState } from "react";
import { ConfirmModal, createLogger } from "@pablozaiden/webapp/web";
import type { PurgeTerminalTasksResult } from "../../hooks";
import { Button } from "../common";

const log = createLogger("PurgeTerminalTasksAction");

export function PurgeTerminalTasksAction({
  onPurgeTerminalTasks,
  purgingTerminalTasks,
}: {
  onPurgeTerminalTasks: () => Promise<PurgeTerminalTasksResult | null>;
  purgingTerminalTasks: boolean;
}) {
  const [showPurgeConfirm, setShowPurgeConfirm] = useState(false);
  const [purgeResult, setPurgeResult] = useState<PurgeTerminalTasksResult | null>(null);
  const [purgeError, setPurgeError] = useState(false);

  async function confirmPurge(): Promise<void> {
    setPurgeError(false);
    try {
      const result = await onPurgeTerminalTasks();
      setShowPurgeConfirm(false);
      if (result) {
        setPurgeResult(result);
      } else {
        setPurgeError(true);
      }
    } catch (error) {
      log.error("Failed to purge terminal-state tasks", { error: String(error) });
      setShowPurgeConfirm(false);
      setPurgeError(true);
    }
  }

  return (
    <div className="clanky-purge-terminal-tasks-action space-y-2">
      <Button
        type="button"
        variant="danger"
        size="sm"
        className="clanky-purge-terminal-tasks-button"
        onClick={() => {
          setPurgeResult(null);
          setPurgeError(false);
          setShowPurgeConfirm(true);
        }}
        disabled={purgingTerminalTasks}
        loading={purgingTerminalTasks}
      >
        Purge terminal-state tasks
      </Button>
      {purgeResult ? (
        <div
          role="status"
          className={`rounded px-2 py-1 text-sm ${
            purgeResult.failures.length > 0
              ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
              : "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
          }`}
        >
          {purgeResult.totalArchived === 0
            ? "No terminal-state tasks were found across all workspaces."
            : purgeResult.failures.length > 0
              ? `Purged ${purgeResult.purgedCount} of ${purgeResult.totalArchived} terminal-state tasks across ${purgeResult.totalWorkspaces} workspaces.`
              : `Purged ${purgeResult.purgedCount} terminal-state tasks across ${purgeResult.totalWorkspaces} workspaces.`}
          {purgeResult.failures.length > 0 ? (
            <div className="mt-1 text-xs">
              Failed task IDs: {purgeResult.failures.map((failure) => failure.taskId).join(", ")}
            </div>
          ) : null}
        </div>
      ) : null}
      {purgeError ? (
        <div role="alert" className="rounded bg-red-100 px-2 py-1 text-sm text-red-600 dark:bg-red-900/30 dark:text-red-400">
          Failed to purge terminal-state tasks. Please try again.
        </div>
      ) : null}
      <ConfirmModal
        isOpen={showPurgeConfirm}
        onClose={() => {
          if (!purgingTerminalTasks) {
            setShowPurgeConfirm(false);
          }
        }}
        onConfirm={() => void confirmPurge()}
        title="Purge terminal-state tasks?"
        message="This permanently deletes archived terminal tasks across every workspace. Addressable pushed and accepted-local tasks are kept."
        confirmLabel="Purge tasks"
        loading={purgingTerminalTasks}
      />
    </div>
  );
}
