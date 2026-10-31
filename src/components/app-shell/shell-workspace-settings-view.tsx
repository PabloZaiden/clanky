import type { Workspace } from "@/shared";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import { WorkspaceSettingsForm } from "../workspace-settings";
import { ErrorState, LoadingState, log, useToast, type WebAppRoute } from "@pablozaiden/webapp/web";
import type { UseWorkspaceSettingsShellResult } from "./use-workspace-settings-shell";

interface WorkspaceSettingsViewProps {
  selectedWorkspace: Workspace;
  workspaceSettings: UseWorkspaceSettingsShellResult;
  dashboardData: UseDashboardDataResult;
  refreshWorkspaces: () => Promise<void>;
  deleteWorkspace: (id: string, options?: import("@/contracts").DeleteWorkspaceRequest) => Promise<{ success: boolean; error?: string }>;
  navigateWithinShell: (route: WebAppRoute) => void;
}

export function WorkspaceSettingsView({
  selectedWorkspace,
  workspaceSettings,
  dashboardData,
  refreshWorkspaces,
  deleteWorkspace,
  navigateWithinShell,
}: WorkspaceSettingsViewProps) {
  const toast = useToast();
  const {
    workspace: workspaceFromHook,
    status: workspaceStatus,
    loading: workspaceSettingsLoading,
    error: workspaceSettingsError,
    saving: workspaceSettingsSaving,
    testing: workspaceSettingsTesting,
    testConnection: testWorkspaceConnection,
    updateWorkspace: updateWorkspaceSettings,
    workspaceSettingsWorkspaceId,
    workspaceArchivedTasksPurging,
    handlePurgeArchivedTasks,
    selectedWorkspaceArchivedTaskCount,
    selectedWorkspaceTaskCount,
  } = workspaceSettings;
  const loadedWorkspace = workspaceFromHook?.id === selectedWorkspace.id ? workspaceFromHook : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {workspaceSettingsError ? (
        <ErrorState title={loadedWorkspace ? "Unable to update workspace settings" : "Unable to load workspace settings"} description={workspaceSettingsError} />
      ) : null}

      {workspaceSettingsLoading && !loadedWorkspace ? (
        <LoadingState title="Loading workspace settings" />
      ) : loadedWorkspace ? (
          <WorkspaceSettingsForm
            key={loadedWorkspace.id}
            workspace={loadedWorkspace}
            status={workspaceStatus}
            onSave={async (
              name,
              settings,
              executionHost,
              archived,
              allowClankyContext,
              allowWorktrees,
            ) => {
              const success = await updateWorkspaceSettings(
                name,
                settings,
                executionHost,
                archived,
                allowClankyContext,
                allowWorktrees,
              );
              if (success) {
                try {
                  await refreshWorkspaces();
                } catch (error) {
                  log.warn("Workspace saved but workspace list refresh failed", error);
                  toast.error("Workspace saved, but the workspace list could not refresh.");
                }
              }
              return success;
            }}
            onWorkspaceIconChanged={refreshWorkspaces}
            onTest={testWorkspaceConnection}
            onPurgeArchivedTasks={
              workspaceSettingsWorkspaceId
                ? async () => await handlePurgeArchivedTasks(workspaceSettingsWorkspaceId)
                : undefined
            }
            onDeleteWorkspace={
              workspaceSettingsWorkspaceId
                ? async (options) => await deleteWorkspace(workspaceSettingsWorkspaceId, options)
                : undefined
            }
            purgeableTaskCount={selectedWorkspaceArchivedTaskCount}
            workspaceTaskCount={selectedWorkspaceTaskCount}
            saving={workspaceSettingsSaving}
            testing={workspaceSettingsTesting}
            purgingPurgeableTasks={workspaceArchivedTasksPurging}
            remoteOnly={dashboardData.remoteOnly}
            formId="workspace-settings-shell-form"
            onDeleted={() => navigateWithinShell({ view: "home" })}
          />
      ) : (
        <ErrorState title="Workspace settings unavailable" description="Workspace settings are unavailable right now." />
      )}
    </div>
  );
}
