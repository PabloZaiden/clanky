/**
 * Workspace instructions status and direct actions.
 */

import { useEffect } from "react";
import { Button, SettingsFieldRow, useToast } from "@pablozaiden/webapp/web";
import { useAgentsMdOptimizer } from "../../hooks/useAgentsMdOptimizer";
import type { Workspace } from "@/shared/workspace";

export function AgentsMdSection({ workspace }: { workspace: Workspace }) {
  const toast = useToast();
  const { status, loading, error, fetchStatus, optimize, reset } = useAgentsMdOptimizer();
  useEffect(() => {
    reset();
    void fetchStatus(workspace.id);
  }, [fetchStatus, reset, workspace.id]);

  async function handleOptimize(): Promise<void> {
    const result = await optimize(workspace.id);
    if (result?.success) toast.success(result.alreadyOptimized ? "AGENTS.md is up to date." : "AGENTS.md updated.");
    else if (result) toast.error("Unable to update AGENTS.md. Try again.");
  }

  const optimized = status?.analysis.isOptimized === true;
  const needsUpdate = optimized && status.analysis.updateAvailable === true;
  const summary = loading && !status ? "Checking..."
    : needsUpdate ? "Update available" : optimized ? "Optimized"
      : status?.fileExists ? "Not optimized" : "Not configured";
  return (
    <SettingsFieldRow title="AGENTS.md"
      feedback={error ? <span role="alert" className="text-red-600 dark:text-red-400">{error}</span> : <span role="status">{summary}</span>}
      actions={error ? <Button loading={loading} onClick={() => void fetchStatus(workspace.id)}>Retry</Button>
        : !optimized || needsUpdate ? <Button disabled={!status} loading={loading}
          onClick={() => void handleOptimize()}>{needsUpdate ? "Update" : "Optimize"}</Button> : undefined} />
  );
}
