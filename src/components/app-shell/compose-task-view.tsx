import type { Workspace } from "@/shared";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import {
  CreateTaskForm,
  getComposeDraftActionLabel,
  getComposeSubmitActionLabel,
  type CreateTaskFormActionState,
} from "../CreateTaskForm";
import type { CreateTaskFormSubmitRequest } from "@/lib/task-request";
import { Button } from "../common";
import { ShellPanel } from "./shell-panel";
import type { WebAppRoute } from "@pablozaiden/webapp/web";

interface ComposeTaskViewProps {
  composeWorkspace: Workspace | null;
  navigateWithinShell: (route: WebAppRoute) => void;
  composeActionState: CreateTaskFormActionState | null;
  setComposeActionState: (state: CreateTaskFormActionState | null) => void;
  handleTaskSubmit: (request: CreateTaskFormSubmitRequest) => Promise<boolean>;
  dashboardData: UseDashboardDataResult;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspaceError: string | null;
}

export function ComposeTaskView(props: ComposeTaskViewProps) {
  const {
    composeWorkspace,
    navigateWithinShell,
    composeActionState,
    setComposeActionState,
    handleTaskSubmit,
    dashboardData,
    workspaces,
    workspacesLoading,
    workspaceError,
  } = props;

  const handleComposeCancel = () =>
    navigateWithinShell(
      composeWorkspace ? { view: "workspace", workspaceId: composeWorkspace.id } : { view: "home" },
    );

  return (
    <ShellPanel
      eyebrow="Task"
      title={
        composeWorkspace
          ? `Start a new task in ${composeWorkspace.name}`
          : "Start a new task"
      }
      description={composeWorkspace?.directory}
      descriptionClassName="hidden sm:inline font-mono"
      variant="compact"
      actions={
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={composeActionState?.onCancel ?? handleComposeCancel}
            disabled={composeActionState?.isSubmitting}
          >
            Cancel
          </Button>
          {composeActionState &&
            (!composeActionState.isEditing || composeActionState.isEditingDraft) && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={composeActionState.onSaveAsDraft}
                aria-label={getComposeDraftActionLabel(composeActionState.isEditingDraft)}
                disabled={!composeActionState.canSaveDraft}
                loading={composeActionState.isSubmitting}
              >
                {getComposeDraftActionLabel(composeActionState.isEditingDraft)}
              </Button>
            )}
          {composeActionState && (
            <Button
              type="button"
              size="sm"
              onClick={composeActionState.onSubmit}
              disabled={!composeActionState.canSubmit}
              loading={composeActionState.isSubmitting}
            >
              {getComposeSubmitActionLabel({
                isEditing: composeActionState.isEditing,
              })}
            </Button>
          )}
        </>
      }
    >
      <CreateTaskForm
        key={`task:${composeWorkspace?.id ?? "none"}`}
        onSubmit={handleTaskSubmit}
        onCancel={handleComposeCancel}
        closeOnSuccess={false}
        models={dashboardData.models}
        modelsLoading={dashboardData.modelsLoading}
        lastModel={dashboardData.lastModel}
        lastCheapModel={dashboardData.lastCheapModel}
        onWorkspaceChange={dashboardData.handleWorkspaceChange}
        planningWarning={dashboardData.planningWarning}
        branches={dashboardData.branches}
        branchesLoading={dashboardData.branchesLoading}
        currentBranch={dashboardData.currentBranch}
        defaultBranch={dashboardData.defaultBranch}
        initialTaskData={
          composeWorkspace
            ? {
                directory: composeWorkspace.directory,
                prompt: "",
                workspaceId: composeWorkspace.id,
              }
            : null
        }
        workspaces={workspaces}
        workspacesLoading={workspacesLoading}
        workspaceError={workspaceError}
        renderActions={setComposeActionState}
      />
    </ShellPanel>
  );
}
