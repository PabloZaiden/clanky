import { useEffect, useMemo, useState } from "react";
import type { PurgeArchivedTasksResult } from "../../hooks";
import type { WorkspaceGroup } from "../../hooks/useTaskGrouping";
import { useWorkspaceServerSettings, type UseWorkspaceServerSettingsResult } from "../../hooks/useWorkspaceServerSettings";
import type { ShellRoute } from "./shell-types";

export interface UseWorkspaceSettingsShellResult extends UseWorkspaceServerSettingsResult {
  workspaceSettingsWorkspaceId: string | null;
  workspaceSettingsFormValid: boolean;
  setWorkspaceSettingsFormValid: (valid: boolean) => void;
  workspaceArchivedTasksPurging: boolean;
  handlePurgeArchivedTasks: (workspaceId: string) => Promise<PurgeArchivedTasksResult>;
  selectedWorkspaceArchivedTaskCount: number;
  selectedWorkspaceTaskCount: number;
}

interface UseWorkspaceSettingsShellOptions {
  route: ShellRoute;
  workspaceGroups: WorkspaceGroup[];
  purgeArchivedWorkspaceTasks: (workspaceId: string) => Promise<PurgeArchivedTasksResult>;
}

export function useWorkspaceSettingsShell({
  route,
  workspaceGroups,
  purgeArchivedWorkspaceTasks,
}: UseWorkspaceSettingsShellOptions): UseWorkspaceSettingsShellResult {
  const workspaceSettingsWorkspaceId = route.view === "workspace-settings" ? route.workspaceId : null;
  const [workspaceSettingsFormValid, setWorkspaceSettingsFormValid] = useState(false);
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

  useEffect(() => {
    if (route.view !== "workspace-settings") {
      setWorkspaceSettingsFormValid(false);
    }
  }, [route.view]);

  useEffect(() => {
    setWorkspaceSettingsFormValid(false);
  }, [workspaceSettingsWorkspaceId]);

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
    workspaceSettingsFormValid,
    setWorkspaceSettingsFormValid,
    workspaceArchivedTasksPurging,
    handlePurgeArchivedTasks,
    selectedWorkspaceArchivedTaskCount,
    selectedWorkspaceTaskCount,
  };
}
