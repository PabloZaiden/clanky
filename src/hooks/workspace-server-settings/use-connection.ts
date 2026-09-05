import { useCallback, useState } from "react";
import { createLogger } from "@pablozaiden/webapp/web";
import type { ServerSettings } from "@/shared/settings";
import type { ExecutionHostRef } from "@/shared";
import { apiRequest } from "../../lib/api-client";

export function useWorkspaceConnection(
  workspaceId: string | null,
  setError: (error: string | null) => void,
) {
  const log = createLogger("useWorkspaceConnection");
  const [testing, setTesting] = useState(false);

  const testConnection = useCallback(
    async (
      testSettings: ServerSettings,
      executionHost: ExecutionHostRef,
    ): Promise<{ success: boolean; error?: string }> => {
      if (!workspaceId) {
        return { success: false, error: "No workspace selected" };
      }

      try {
        setTesting(true);
        setError(null);

        return await apiRequest<{ success: boolean; error?: string }>(
          `/api/workspaces/${workspaceId}/server-settings/test`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ settings: testSettings, executionHost }),
            action: "Test workspace server connection",
            fallbackMessage: "Failed to test workspace server connection",
          },
        );
      } catch (err) {
        log.error("Failed to test workspace server connection", {
          workspaceId,
          error: String(err),
        });
        return { success: false, error: String(err) };
      } finally {
        setTesting(false);
      }
    },
    [workspaceId, setError]
  );

  return { testing, testConnection };
}
