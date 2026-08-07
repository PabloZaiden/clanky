/**
 * Sub-hook for checking the planning directory status.
 */

import { useState, useCallback, useRef } from "react";
import { createLogger } from "@pablozaiden/webapp/web";
import { apiRequest } from "../../lib/api-client";

export interface UsePlanningDirResult {
  planningWarning: string | null;
  checkPlanningDir: (workspaceId: string | null) => Promise<void>;
  resetPlanningWarning: () => void;
}

export function usePlanningDir(): UsePlanningDirResult {
  const log = createLogger("usePlanningDir");
  const [planningWarning, setPlanningWarning] = useState<string | null>(null);
  const planningRequestIdRef = useRef(0);

  const checkPlanningDir = useCallback(async (workspaceId: string | null) => {
    const requestId = ++planningRequestIdRef.current;
    if (!workspaceId) {
      setPlanningWarning(null);
      return;
    }

    try {
      const data = await apiRequest<{ warning?: string }>(
        `/api/check-planning-dir?workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          action: "Check planning directory",
          fallbackMessage: "Failed to check planning directory status",
        },
      );
      if (requestId !== planningRequestIdRef.current) {
        return;
      }
      setPlanningWarning(data.warning ?? null);
    } catch (error) {
      log.warn("Failed to check planning directory status", {
        workspaceId,
        error: String(error),
      });
      if (requestId === planningRequestIdRef.current) {
        setPlanningWarning(null);
      }
    }
  }, []);

  const resetPlanningWarning = useCallback(() => {
    setPlanningWarning(null);
  }, []);

  return { planningWarning, checkPlanningDir, resetPlanningWarning };
}
