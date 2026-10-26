import { useMemo, useState } from "react";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import type { PurgeArchivedTasksResult } from "../../hooks";
import type { WorkspaceGroup } from "../../hooks/useTaskGrouping";
import { useWorkspaceServerSettings, type UseWorkspaceServerSettingsResult } from "../../hooks/useWorkspaceServerSettings";
import { getRouteString } from "./route-fields";

export interface UseWorkspaceSettingsShellResult extends UseWorkspaceServerSettingsResult {
  workspaceSettingsWorkspaceId: string | null;
  workspaceArchivedTasksPurging: boolean;
  handlePurgeArchivedTasks: (workspaceId: string) => Promise<PurgeArchivedTasksResult>;
  selectedWorkspaceArchivedTaskCount: number;
  selectedWorkspaceTaskCount: number;
}

interface UseWorkspaceSettingsShellOptions {
  route: WebAppRoute;
  workspaceGroups: WorkspaceGroup[];
  purgeArchivedWorkspaceTasks: (workspaceId: string) => Promise<PurgeArchivedTasksResult>;
}

export function useWorkspaceSettingsShell({
  route,
  workspaceGroups,
  purgeArchivedWorkspaceTasks,
}: UseWorkspaceSettingsShellOptions): UseWorkspaceSettingsShellResult {
  const workspaceSettingsWorkspaceId = route.view === "workspace-settings"
    ? getRouteString(route, "workspaceId") ?? null
    : null;
  const [workspaceArchivedTasksPurging, setWorkspaceArchivedTasksPurging] = useState(false);

  const workspaceServerSettings = useWorkspaceServerSettings(workspaceSettingsWorkspaceId);

  const selectedWorkspaceArchivedTaskCount = useMemo(() => {
    if (!workspaceSettingsWorkspaceId) {
      return 0;
    }
    return (
      workspaceGroups.find((group) => group.workspace.id === workspaceSettingsWorkspaceId)?.statusGroups.archived
        .length ?? 0
    );
  }, [workspaceGroups, workspaceSettingsWorkspaceId]);

  const selectedWorkspaceTaskCount = useMemo(() => {
    if (!workspaceSettingsWorkspaceId) {
      return 0;
    }
    return workspaceGroups.find((group) => group.workspace.id === workspaceSettingsWorkspaceId)?.tasks.length ?? 0;
  }, [workspaceGroups, workspaceSettingsWorkspaceId]);

  async function handlePurgeArchivedTasks(workspaceId: string): Promise<PurgeArchivedTasksResult> {
    try {
      setWorkspaceArchivedTasksPurging(true);
      return await purgeArchivedWorkspaceTasks(workspaceId);
    } finally {
      setWorkspaceArchivedTasksPurging(false);
    }
  }

  return {
    ...workspaceServerSettings,
    workspaceSettingsWorkspaceId,
    workspaceArchivedTasksPurging,
    handlePurgeArchivedTasks,
    selectedWorkspaceArchivedTaskCount,
    selectedWorkspaceTaskCount,
  };
}
