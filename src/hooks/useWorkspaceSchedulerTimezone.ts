/**
 * Loads scheduling defaults from the selected workspace's authoritative owner.
 */

import { useLiveQuery } from "@pablozaiden/webapp/web";
import { SetSchedulerTimezoneRequestSchema } from "@/contracts/schemas";
import { apiRequest } from "../lib/api-client";

export function useWorkspaceSchedulerTimezone(workspaceId: string, existingTimezone?: string) {
  const query = useLiveQuery<{ workspaceId: string; timezone: string }>({
    enabled: Boolean(workspaceId) && !existingTimezone,
    deps: [workspaceId, existingTimezone],
    realtime: false,
    load: async (signal) => {
      const response = await apiRequest<unknown>(
        `/api/preferences/scheduler-timezone?workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          signal,
          action: "Load workspace scheduling defaults",
          fallbackMessage: "Failed to load scheduling defaults from the workspace controller",
        },
      );
      return { workspaceId, ...SetSchedulerTimezoneRequestSchema.parse(response) };
    },
  });
  return {
    timezone: existingTimezone ?? (query.data?.workspaceId === workspaceId ? query.data.timezone : null),
    loading: query.loading,
    error: existingTimezone ? null : query.error ?? null,
    refresh: query.refresh,
  };
}
