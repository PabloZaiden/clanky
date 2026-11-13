import type { WebAppRoute } from "@pablozaiden/webapp/web";
import { useWorkspaceServerSettings, type UseWorkspaceServerSettingsResult } from "../../hooks/useWorkspaceServerSettings";
import { getRouteString } from "./route-fields";

export interface UseWorkspaceSettingsShellResult extends UseWorkspaceServerSettingsResult {
  workspaceSettingsWorkspaceId: string | null;
}

export function useWorkspaceSettingsShell({ route }: { route: WebAppRoute }): UseWorkspaceSettingsShellResult {
  const workspaceSettingsWorkspaceId = route.view === "workspace-settings"
    ? getRouteString(route, "workspaceId") ?? null
    : null;
  return {
    ...useWorkspaceServerSettings(workspaceSettingsWorkspaceId),
    workspaceSettingsWorkspaceId,
  };
}
