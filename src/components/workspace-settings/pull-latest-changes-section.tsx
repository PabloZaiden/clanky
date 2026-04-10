/**
 * Pull-latest workspace maintenance panel.
 */

import { useState } from "react";
import { Button } from "../common";
import { useToast } from "../../hooks";
import type { Workspace } from "../../types/workspace";

interface PullLatestChangesSectionProps {
  workspace: Workspace;
  onPullLatestChanges: () => Promise<{
    success: boolean;
    defaultBranch?: string;
    currentBranch?: string;
    error?: string;
  }>;
  disabled?: boolean;
}

export function PullLatestChangesSection({
  workspace,
  onPullLatestChanges,
  disabled = false,
}: PullLatestChangesSectionProps) {
  const toast = useToast();
  const [pulling, setPulling] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handlePullLatestChanges() {
    setPulling(true);
    setResultMessage(null);
    setErrorMessage(null);

    try {
      const result = await onPullLatestChanges();
      if (!result.success) {
        const message = result.error ?? "Failed to pull latest changes";
        setErrorMessage(message);
        toast.error(message);
        return;
      }

      const branchLabel = result.defaultBranch ?? result.currentBranch ?? "the default branch";
      const message = `Pulled latest changes for "${branchLabel}".`;
      setResultMessage(message);
      toast.success(message);
    } catch (error) {
      const message = String(error);
      setErrorMessage(message);
      toast.error(message);
    } finally {
      setPulling(false);
    }
  }

  return (
    <div className="border-t border-gray-200 pt-6 dark:border-gray-700">
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950/20">
        <h3 className="mb-2 text-sm font-medium text-blue-900 dark:text-blue-100">
          Pull Latest Changes
        </h3>
        <p className="mb-4 text-sm text-blue-800 dark:text-blue-200">
          Fast-forward the workspace&apos;s default branch from its remote. This action requires the
          repository to already be on the default branch with no uncommitted changes.
        </p>

        {resultMessage && (
          <div className="mb-3 rounded-md border border-green-200 bg-green-50 p-3 dark:border-green-900 dark:bg-green-900/20">
            <p className="text-sm text-green-700 dark:text-green-300">{resultMessage}</p>
          </div>
        )}

        {errorMessage && (
          <div className="mb-3 rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-900/20">
            <p className="text-sm text-red-700 dark:text-red-300">{errorMessage}</p>
          </div>
        )}

        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void handlePullLatestChanges()}
          loading={pulling}
          disabled={disabled}
        >
          Pull Latest Changes
        </Button>

        <p className="mt-2 text-xs text-blue-800/80 dark:text-blue-200/80">
          Workspace: {workspace.name}
        </p>
      </div>
    </div>
  );
}
