import type { Workspace } from "@/shared";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import { Button } from "../common";
import { WorkspaceSettingsForm } from "../workspace-settings";
import { ProvisioningActionsSection } from "../workspace-settings";
import { ErrorState, LoadingState, type WebAppRoute } from "@pablozaiden/webapp/web";
import type { UseWorkspaceSettingsShellResult } from "./use-workspace-settings-shell";
import { useShellHeaderActions } from "./shell-header-actions";

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
    workspaceSettingsFormValid,
    setWorkspaceSettingsFormValid,
    workspaceArchivedTasksPurging,
    handlePurgeArchivedTasks,
    selectedWorkspaceArchivedTaskCount,
    selectedWorkspaceTaskCount,
  } = workspaceSettings;

  useShellHeaderActions(
    <Button
      type="submit"
      form="workspace-settings-shell-form"
      size="sm"
      loading={workspaceSettingsSaving}
      disabled={!workspaceSettingsFormValid || workspaceSettingsLoading || !workspaceFromHook}
    >
      <span className="sm:hidden">Save</span>
      <span className="hidden sm:inline">Save Changes</span>
    </Button>,
  );

  return (
    <div className="space-y-6">
      {workspaceSettingsError ? (
        <ErrorState title="Unable to load workspace settings" description={workspaceSettingsError} />
      ) : null}

      {workspaceSettingsLoading && !workspaceFromHook ? (
        <LoadingState title="Loading workspace settings" />
      ) : workspaceFromHook ? (
        <div className="space-y-6">
          <WorkspaceSettingsForm
            workspace={workspaceFromHook}
            status={workspaceStatus}
            onSave={async (name, settings, archived) => {
              const success = await updateWorkspaceSettings(name, settings, archived);
              if (success) {
                await refreshWorkspaces();
              }
              return success;
            }}
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
            showConnectionStatus={false}
            formId="workspace-settings-shell-form"
            onSaved={() => navigateWithinShell({ view: "workspace", workspaceId: selectedWorkspace.id })}
            onDeleted={() => navigateWithinShell({ view: "home" })}
            onValidityChange={setWorkspaceSettingsFormValid}
          />

          {workspaceFromHook.sourceDirectory && (
            <ProvisioningActionsSection
              workspace={workspaceFromHook}
              onRestart={() => navigateWithinShell({ view: "restart-workspace", workspaceId: workspaceFromHook.id })}
              onRebuild={() => navigateWithinShell({ view: "rebuild-workspace", workspaceId: workspaceFromHook.id })}
            />
          )}
        </div>
      ) : (
        <ErrorState title="Workspace settings unavailable" description="Workspace settings are unavailable right now." />
      )}
    </div>
  );
}
