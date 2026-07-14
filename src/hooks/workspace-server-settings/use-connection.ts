import { useCallback, useState } from "react";
import { createLogger } from "../../lib/logger";
import type { ServerSettings } from "@/shared/settings";
import { appFetch } from "../../lib/public-path";

export function useWorkspaceConnection(
  workspaceId: string | null,
  setError: (error: string | null) => void,
) {
  const log = createLogger("useWorkspaceConnection");
  const [testing, setTesting] = useState(false);

  const testConnection = useCallback(
    async (testSettings?: ServerSettings): Promise<{ success: boolean; error?: string }> => {
      if (!workspaceId) {
        return { success: false, error: "No workspace selected" };
      }

      try {
        setTesting(true);
        setError(null);

        const response = await appFetch(`/api/workspaces/${workspaceId}/server-settings/test`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: testSettings ? JSON.stringify(testSettings) : "{}",
        });

        const data = (await response.json()) as { success: boolean; error?: string };
        return data;
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
