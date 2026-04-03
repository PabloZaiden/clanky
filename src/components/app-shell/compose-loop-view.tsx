import type { Workspace } from "../../types";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import {
  CreateLoopForm,
  getComposeDraftActionLabel,
  getComposeSubmitActionLabel,
  type CreateLoopFormActionState,
  type CreateLoopFormSubmitRequest,
} from "../CreateLoopForm";
import { Button } from "../common";
import { ShellPanel } from "./shell-panel";
import type { ShellRoute } from "./shell-types";

interface ComposeLoopViewProps {
  composeWorkspace: Workspace | null;
  shellHeaderOffsetClassName: string;
  navigateWithinShell: (route: ShellRoute) => void;
  composeActionState: CreateLoopFormActionState | null;
  setComposeActionState: (state: CreateLoopFormActionState | null) => void;
  handleLoopSubmit: (request: CreateLoopFormSubmitRequest) => Promise<boolean>;
  dashboardData: UseDashboardDataResult;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspaceError: string | null;
}

export function ComposeLoopView(props: ComposeLoopViewProps) {
  const {
    composeWorkspace,
    shellHeaderOffsetClassName,
    navigateWithinShell,
    composeActionState,
    setComposeActionState,
    handleLoopSubmit,
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
      eyebrow="Loop"
      title={
        composeWorkspace
          ? `Start a new loop in ${composeWorkspace.name}`
          : "Start a new loop"
      }
      description={composeWorkspace?.directory}
      descriptionClassName="hidden sm:inline font-mono"
      variant="compact"
      headerOffsetClassName={shellHeaderOffsetClassName}
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
      <CreateLoopForm
        key={`loop:${composeWorkspace?.id ?? "none"}`}
        onSubmit={handleLoopSubmit}
        onCancel={handleComposeCancel}
        closeOnSuccess={false}
        models={dashboardData.models}
        modelsLoading={dashboardData.modelsLoading}
        lastModel={dashboardData.lastModel}
        onWorkspaceChange={dashboardData.handleWorkspaceChange}
        planningWarning={dashboardData.planningWarning}
        branches={dashboardData.branches}
        branchesLoading={dashboardData.branchesLoading}
        currentBranch={dashboardData.currentBranch}
        defaultBranch={dashboardData.defaultBranch}
        initialLoopData={
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
