import { useState } from "react";
import type { Loop, Workspace } from "../../types";
import { useDashboardData, useToast } from "../../hooks";
import {
  CreateLoopForm,
  getComposeDraftActionLabel,
  getComposeSubmitActionLabel,
  type CreateLoopFormActionState,
} from "../CreateLoopForm";
import type { CreateLoopFormSubmitRequest } from "../../types/loop-request";
import { Button, ConfirmModal } from "../common";
import type { ShellRoute } from "./shell-types";
import { ShellPanel } from "./shell-panel";
import { persistDraftChanges, startDraftLoop } from "../../lib/draft-loop-start";

export function DraftLoopComposer({
  loop,
  workspaces,
  models,
  modelsLoading,
  lastModel,
  lastCheapModel,
  setLastModel,
  setLastCheapModel,
  onWorkspaceChange,
  planningWarning,
  branches,
  branchesLoading,
  currentBranch,
  defaultBranch,
  workspaceError,
  workspacesLoading,
  headerOffsetClassName,
  onRefresh,
  onDeleteDraft,
  onNavigate,
}: {
  loop: Loop;
  workspaces: Workspace[];
  models: ReturnType<typeof useDashboardData>["models"];
  modelsLoading: boolean;
  lastModel: ReturnType<typeof useDashboardData>["lastModel"];
  lastCheapModel: ReturnType<typeof useDashboardData>["lastCheapModel"];
  setLastModel: ReturnType<typeof useDashboardData>["setLastModel"];
  setLastCheapModel: ReturnType<typeof useDashboardData>["setLastCheapModel"];
  onWorkspaceChange: ReturnType<typeof useDashboardData>["handleWorkspaceChange"];
  planningWarning: string | null;
  branches: ReturnType<typeof useDashboardData>["branches"];
  branchesLoading: boolean;
  currentBranch: string;
  defaultBranch: string;
  workspaceError: string | null;
  workspacesLoading: boolean;
  headerOffsetClassName?: string;
  onRefresh: () => Promise<void>;
  onDeleteDraft: (id: string) => Promise<boolean>;
  onNavigate: (route: ShellRoute) => void;
}) {
  const toast = useToast();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [actionState, setActionState] = useState<CreateLoopFormActionState | null>(null);

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === loop.config.workspaceId) ?? null;
  const exitRoute = selectedWorkspace
    ? { view: "workspace", workspaceId: selectedWorkspace.id } satisfies ShellRoute
    : { view: "home" } satisfies ShellRoute;

  function handleCancel() {
    setDeleteConfirmOpen(false);
    onNavigate(exitRoute);
  }

  async function handleDraftSubmit(request: CreateLoopFormSubmitRequest): Promise<boolean> {
    if (!("name" in request)) {
      toast.error("Draft loops currently support loop mode only.");
      return false;
    }

    if (request.draft) {
      return await persistDraftChanges({
        loopId: loop.config.id,
        request,
        workspaces,
        setLastModel,
        setLastCheapModel,
        onRefresh,
        onUpdateError: (message) => {
          toast.error(message);
        },
      });
    }

    void (async () => {
      const persisted = await persistDraftChanges({
        loopId: loop.config.id,
        request,
        workspaces,
        setLastModel,
        setLastCheapModel,
        onRefresh,
        onUpdateError: (message) => {
          toast.error(message);
        },
      });
      if (!persisted) {
        return;
      }

      const result = await startDraftLoop({
        loopId: loop.config.id,
        request,
        onRefresh,
      });

      if (result.status === "uncommitted_changes") {
        toast.error("Uncommitted changes blocked the new run. Resolve them and try again.");
        return;
      }

      if (result.status === "failed") {
        toast.error(result.message);
      }
    })();

    onNavigate(exitRoute);
    return true;
  }

  async function handleDeleteDraft() {
    setDeleteSubmitting(true);
    try {
      const deleted = await onDeleteDraft(loop.config.id);
      if (!deleted) {
        toast.error("Failed to delete draft");
        return;
      }
      onNavigate(exitRoute);
    } finally {
      setDeleteSubmitting(false);
    }
  }

  return (
    <ShellPanel
      eyebrow="Draft loop"
      title={`Edit ${loop.config.name}`}
      variant="compact"
      headerOffsetClassName={headerOffsetClassName}
      actions={(
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={actionState?.onCancel ?? handleCancel}
            disabled={deleteSubmitting || actionState?.isSubmitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={() => setDeleteConfirmOpen(true)}
            disabled={deleteSubmitting || actionState?.isSubmitting}
          >
            Delete
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={actionState?.onSaveAsDraft}
            disabled={deleteSubmitting || !actionState?.canSaveDraft}
            loading={actionState?.isSubmitting ?? false}
          >
            {getComposeDraftActionLabel(true)}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={actionState?.onSubmit}
            disabled={deleteSubmitting || !actionState?.canSubmit}
            loading={actionState?.isSubmitting ?? false}
          >
            {getComposeSubmitActionLabel({
              isEditing: true,
            })}
          </Button>
        </>
      )}
    >
      <CreateLoopForm
        onSubmit={handleDraftSubmit}
        onCancel={handleCancel}
        closeOnSuccess={false}
        models={models}
        modelsLoading={modelsLoading}
        lastModel={lastModel}
        lastCheapModel={lastCheapModel}
        onWorkspaceChange={onWorkspaceChange}
        planningWarning={planningWarning}
        branches={branches}
        branchesLoading={branchesLoading}
        currentBranch={currentBranch}
        defaultBranch={defaultBranch}
        editLoopId={loop.config.id}
        initialLoopData={{
           name: loop.config.name,
           directory: loop.config.directory,
           prompt: loop.config.prompt,
           model: loop.config.model,
           cheapModel: loop.config.cheapModel,
           maxIterations: Number.isFinite(loop.config.maxIterations) ? loop.config.maxIterations : undefined,
          maxConsecutiveErrors: loop.config.maxConsecutiveErrors,
          activityTimeoutSeconds: loop.config.activityTimeoutSeconds,
          baseBranch: loop.config.baseBranch,
          useWorktree: loop.config.useWorktree,
           clearPlanningFolder: loop.config.clearPlanningFolder,
           planMode: loop.config.planMode,
           autoAcceptPlan: loop.config.autoAcceptPlan,
            workspaceId: loop.config.workspaceId,
          }}
        isEditingDraft
        workspaces={workspaces}
        workspacesLoading={workspacesLoading}
        workspaceError={workspaceError}
        renderActions={setActionState}
      />

      <ConfirmModal
        isOpen={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        onConfirm={() => void handleDeleteDraft()}
        title="Delete Draft"
        message={`Are you sure you want to delete "${loop.config.name}"?`}
        confirmLabel="Delete Draft"
        loading={deleteSubmitting}
        variant="danger"
      />
    </ShellPanel>
  );
}
