import { useEffect, useState } from "react";
import { createLogger } from "@pablozaiden/webapp/web";
import { apiRequest } from "../../lib/api-client";
import type { GitRemoteStatusResponse } from "@/contracts";

const log = createLogger("useTaskRemoteStatus");

interface UseTaskRemoteStatusOptions {
  workspaceId?: string;
}

export interface UseTaskRemoteStatusResult {
  hasOriginRemote: boolean | null;
  loading: boolean;
}

export function useTaskRemoteStatus({
  workspaceId,
}: UseTaskRemoteStatusOptions): UseTaskRemoteStatusResult {
  const [hasOriginRemote, setHasOriginRemote] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!workspaceId) {
      setHasOriginRemote(null);
      setLoading(false);
      return;
    }

    const targetWorkspaceId = workspaceId;
    const controller = new AbortController();
    setLoading(true);

    async function fetchRemoteStatus() {
      try {
        const data = await apiRequest<GitRemoteStatusResponse>(
          `/api/git/remote-status?workspaceId=${encodeURIComponent(targetWorkspaceId)}`,
          {
            signal: controller.signal,
            action: "Fetch task remote status",
            fallbackMessage: "Failed to fetch task remote status",
          },
        );
        if (controller.signal.aborted) {
          return;
        }
        if (!controller.signal.aborted) {
          setHasOriginRemote(data.hasRemote);
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        log.warn("Failed to fetch task remote status", {
          workspaceId: targetWorkspaceId,
          error: String(error),
        });
        setHasOriginRemote(null);
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    void fetchRemoteStatus();

    return () => {
      controller.abort();
    };
  }, [workspaceId]);

  return { hasOriginRemote, loading };
}
