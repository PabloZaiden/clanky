import type { Workspace } from "../../types";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import { Button } from "../common";
import { WorkspaceSettingsForm } from "../WorkspaceSettingsModal";
import { ProvisioningActionsSection } from "../workspace-settings";
import { ShellPanel } from "./shell-panel";
import type { ShellRoute } from "./shell-types";
import type { UseWorkspaceSettingsShellResult } from "./use-workspace-settings-shell";

interface WorkspaceSettingsViewProps {
  selectedWorkspace: Workspace;
  workspaceSettings: UseWorkspaceSettingsShellResult;
  dashboardData: UseDashboardDataResult;
  refreshWorkspaces: () => Promise<void>;
  deleteWorkspace: (id: string, options?: import("../../types").DeleteWorkspaceRequest) => Promise<{ success: boolean; error?: string }>;
  navigateWithinShell: (route: ShellRoute) => void;
  shellHeaderOffsetClassName: string;
}

export function WorkspaceSettingsView({
  selectedWorkspace,
  workspaceSettings,
  dashboardData,
  refreshWorkspaces,
  deleteWorkspace,
  navigateWithinShell,
  shellHeaderOffsetClassName,
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
    workspaceArchivedLoopsPurging,
    handlePurgeArchivedLoops,
    selectedWorkspaceArchivedLoopCount,
    selectedWorkspaceLoopCount,
  } = workspaceSettings;

  return (
    <ShellPanel
      eyebrow="Workspace settings"
      title="Workspace Settings"
      description={workspaceFromHook?.directory ?? selectedWorkspace.directory}
      descriptionClassName="hidden sm:inline font-mono"
      variant="compact"
      headerOffsetClassName={shellHeaderOffsetClassName}
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
            onSave={async (name, settings) => {
              const success = await updateWorkspaceSettings(name, settings);
              if (success) {
                await refreshWorkspaces();
              }
              return success;
            }}
            onTest={testWorkspaceConnection}
            onPurgeArchivedLoops={
              workspaceSettingsWorkspaceId
                ? async () => await handlePurgeArchivedLoops(workspaceSettingsWorkspaceId)
                : undefined
            }
            onDeleteWorkspace={
              workspaceSettingsWorkspaceId
                ? async (options) => await deleteWorkspace(workspaceSettingsWorkspaceId, options)
                : undefined
            }
            purgeableLoopCount={selectedWorkspaceArchivedLoopCount}
            workspaceLoopCount={selectedWorkspaceLoopCount}
            saving={workspaceSettingsSaving}
            testing={workspaceSettingsTesting}
            purgingPurgeableLoops={workspaceArchivedLoopsPurging}
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
