import { useCallback, useEffect, useState } from "react";
import type { WorkspaceExecutionTarget } from "@/shared/workspace";
import { apiRequest } from "../../lib/api-client";
import { createLogger } from "@pablozaiden/webapp/web";

const log = createLogger("useWorkspaceExecutionTargets");

export function useWorkspaceExecutionTargets(): {
  targets: WorkspaceExecutionTarget[];
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [targets, setTargets] = useState<WorkspaceExecutionTarget[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setTargets(await apiRequest<WorkspaceExecutionTarget[]>("/api/workspaces/execution-targets", {
        action: "Load workspace execution targets",
        fallbackMessage: "Failed to load workspace execution targets",
      }));
    } catch (error) {
      log.warn("Failed to load workspace execution targets", { error: String(error) });
      setTargets([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { targets, loading, refresh };
}
