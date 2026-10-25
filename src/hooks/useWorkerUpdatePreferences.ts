import { useLiveQuery } from "@pablozaiden/webapp/web";
import type { WorkerUpdatePreferences } from "@/shared/worker-update";
import { CLANKY_REALTIME_RESOURCES } from "@/shared/realtime";
import { apiRequest } from "../lib/api-client";

export function useWorkerUpdatePreferences({ enabled = true }: { enabled?: boolean } = {}) {
  return useLiveQuery<WorkerUpdatePreferences>({
    enabled,
    load: async (signal) => await apiRequest<WorkerUpdatePreferences>("/api/preferences/worker-updates", {
      signal,
      action: "Load worker update preferences",
      fallbackMessage: "Failed to load worker update preferences",
    }),
    realtime: { resources: [CLANKY_REALTIME_RESOURCES.workerUpdatePreferences], enabled },
  });
}
