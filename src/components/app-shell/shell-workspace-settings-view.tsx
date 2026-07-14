import type { Workspace } from "@/shared";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import { Button } from "../common";
import { WorkspaceSettingsForm } from "../WorkspaceSettingsModal";
import { ProvisioningActionsSection } from "../workspace-settings";
import { ShellPanel } from "./shell-panel";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
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

  return (
    <ShellPanel
      eyebrow="Workspace settings"
      title="Workspace Settings"
      description={workspaceFromHook?.directory ?? selectedWorkspace.directory}
      descriptionClassName="hidden sm:inline font-mono"
      variant="compact"
      actions={
        <Button
          type="submit"
          form="workspace-settings-shell-form"
          size="sm"
          loading={workspaceSettingsSaving}
          disabled={!workspaceSettingsFormValid || workspaceSettingsLoading || !workspaceFromHook}
        >
          <span className="sm:hidden">Save</span>
          <span className="hidden sm:inline">Save Changes</span>
        </Button>
      }
    >
      {workspaceSettingsError && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-900/20 dark:text-red-300">
          {workspaceSettingsError}
        </div>
      )}

      {workspaceSettingsLoading && !workspaceFromHook ? (
        <div className="text-sm text-gray-500 dark:text-gray-400">Loading workspace settings…</div>
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
        <div className="text-sm text-gray-500 dark:text-gray-400">
          Workspace settings are unavailable right now.
        </div>
      )}
    </ShellPanel>
  );
}
