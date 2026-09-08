/**
 * AGENTS.md optimization panel within workspace settings.
 */

import { useState, useEffect } from "react";
import { StatusBadge } from "../common";
import { ActionMenu } from "@pablozaiden/webapp/web";
import { useAgentsMdOptimizer } from "../../hooks/useAgentsMdOptimizer";
import type { Workspace } from "@/shared/workspace";
import { LoadingSpinner, DocumentIcon } from "./icons";

interface AgentsMdSectionProps {
  workspace: Workspace;
}

export function AgentsMdSection({ workspace }: AgentsMdSectionProps) {
  const {
    status: optimizerStatus,
    loading: optimizerLoading,
    error: optimizerError,
    fetchStatus: fetchOptimizerStatus,
    optimize: optimizeAgentsMd,
    reset: resetOptimizer,
  } = useAgentsMdOptimizer();

  const [optimizeSuccess, setOptimizeSuccess] = useState<boolean | null>(null);
  const [wasAlreadyOptimized, setWasAlreadyOptimized] = useState(false);

  useEffect(() => {
    setOptimizeSuccess(null);
    setWasAlreadyOptimized(false);
    resetOptimizer();
    void fetchOptimizerStatus(workspace.id);
  }, [fetchOptimizerStatus, resetOptimizer, workspace]);

  async function handleOptimize() {
    setOptimizeSuccess(null);
    setWasAlreadyOptimized(false);
    const result = await optimizeAgentsMd(workspace.id);
    if (result) {
      setOptimizeSuccess(true);
      setWasAlreadyOptimized(result.alreadyOptimized);
    }
  }

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 pt-6 mt-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          AGENTS.md Optimization
        </h3>
        {optimizerStatus?.analysis.isOptimized && (
          <StatusBadge variant="success" size="sm">Optimized</StatusBadge>
        )}
      </div>
      {optimizerLoading && !optimizerStatus && (
        <div className="flex items-center gap-2 mb-3 p-3 rounded-md bg-gray-50 dark:bg-neutral-900">
          <LoadingSpinner className="w-4 h-4 text-gray-400 flex-shrink-0" />
          <span className="text-sm text-gray-600 dark:text-gray-400">
            Checking AGENTS.md status...
          </span>
        </div>
      )}

      {optimizerError && (
        <div className="mb-3 p-3 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900">
          <p className="text-sm text-red-700 dark:text-red-300">{optimizerError}</p>
          <ActionMenu
            ariaLabel="AGENTS.md actions"
            triggerVariant="ghost"
            triggerSize="compact"
            items={[{
              id: "retry",
              label: "Retry",
              disabled: optimizerLoading,
              onAction: () => void fetchOptimizerStatus(workspace.id),
            }]}
          />
        </div>
      )}

      {optimizeSuccess && (
        <div className="mb-3 p-3 rounded-md bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-900">
          <p className="text-sm text-green-700 dark:text-green-300">
            {wasAlreadyOptimized
              ? "AGENTS.md is already optimized."
              : "AGENTS.md optimized successfully."}
          </p>
        </div>
      )}

      {optimizerStatus && !optimizerStatus.analysis.isOptimized && (
        <div className="flex items-center gap-2 mb-3 p-3 rounded-md bg-gray-50 dark:bg-neutral-900">
          <DocumentIcon className="w-4 h-4 text-gray-400 flex-shrink-0" />
          <span className="text-sm text-gray-600 dark:text-gray-400">
            {optimizerStatus.fileExists
              ? "AGENTS.md exists but is not optimized for Clanky."
              : "No AGENTS.md file found. One will be created."}
          </span>
        </div>
      )}

      {optimizerStatus?.analysis.updateAvailable && optimizerStatus.analysis.isOptimized && (
        <div className="flex items-center gap-2 mb-3 p-3 rounded-md bg-blue-50 dark:bg-neutral-900/40 border border-blue-200 dark:border-gray-700">
          <span className="text-sm text-blue-700 dark:text-blue-300">
            An updated version of the Clanky guidelines is available.
          </span>
        </div>
      )}

      {(!optimizerStatus?.analysis.isOptimized || optimizerStatus?.analysis.updateAvailable) && !optimizerError && (
        <ActionMenu
          ariaLabel="AGENTS.md actions"
          triggerVariant="ghost"
          triggerSize="compact"
          items={[{
            id: "optimize",
            label: optimizerStatus?.analysis.updateAvailable && optimizerStatus.analysis.isOptimized
              ? "Update"
              : "Optimize",
            disabled: optimizerLoading || !optimizerStatus,
            onAction: () => void handleOptimize(),
          }]}
        />
      )}
    </div>
  );
}
