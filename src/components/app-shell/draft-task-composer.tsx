import { useCallback, useMemo, useState } from "react";
import type { Task, Workspace } from "@/shared";
import { useDashboardData } from "../../hooks";
import {
  CreateTaskForm,
  getComposeDraftActionLabel,
  getComposeSubmitActionLabel,
  type CreateTaskFormActionState,
} from "../CreateTaskForm";
import type { CreateTaskFormSubmitRequest } from "@/lib/task-request";
import { ConfirmModal, useToast, type WebAppRoute } from "@pablozaiden/webapp/web";
import { Button } from "../common";
import { persistDraftChanges, startDraftTask } from "../../lib/draft-task-start";
import { useShellHeaderActions } from "./shell-header-actions";

export function DraftTaskComposer({
  task,
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
  onRefresh,
  onDeleteDraft,
  onNavigate,
}: {
  task: Task;
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
  onRefresh: () => Promise<void>;
  onDeleteDraft: (id: string) => Promise<boolean>;
  onNavigate: (route: WebAppRoute) => void;
}) {
  const toast = useToast();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [actionState, setActionState] = useState<CreateTaskFormActionState | null>(null);

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === task.config.workspaceId) ?? null;
  const exitRoute = useMemo(
    () => selectedWorkspace
      ? { view: "workspace", workspaceId: selectedWorkspace.id } satisfies WebAppRoute
      : { view: "home" } satisfies WebAppRoute,
    [selectedWorkspace],
  );

  const handleCancel = useCallback(() => {
    setDeleteConfirmOpen(false);
    onNavigate(exitRoute);
  }, [exitRoute, onNavigate]);

  async function handleDraftSubmit(request: CreateTaskFormSubmitRequest): Promise<boolean> {
    if (!("name" in request)) {
      toast.error("Draft tasks currently support task mode only.");
      return false;
    }

    if (request.draft) {
      return await persistDraftChanges({
        taskId: task.config.id,
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
        taskId: task.config.id,
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

      const result = await startDraftTask({
        taskId: task.config.id,
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
      const deleted = await onDeleteDraft(task.config.id);
      if (!deleted) {
        toast.error("Failed to delete draft");
        return;
      }
      onNavigate(exitRoute);
    } finally {
      setDeleteSubmitting(false);
    }
  }

  const headerActions = useMemo(() => (
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
        {getComposeSubmitActionLabel({ isEditing: true })}
      </Button>
    </>
  ), [actionState, deleteSubmitting, handleCancel]);
  useShellHeaderActions(headerActions);

  return (
    <>
      <CreateTaskForm
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
        editTaskId={task.config.id}
        initialTaskData={{
           name: task.config.name,
           directory: task.config.directory,
           prompt: task.config.prompt,
           issueNumber: task.config.issueNumber,
           model: task.config.model,
           cheapModel: task.config.cheapModel,
           maxIterations: Number.isFinite(task.config.maxIterations) ? task.config.maxIterations : undefined,
          maxConsecutiveErrors: task.config.maxConsecutiveErrors,
          activityTimeoutSeconds: task.config.activityTimeoutSeconds,
          baseBranch: task.config.baseBranch,
          useWorktree: task.config.useWorktree,
           clearPlanningFolder: task.config.clearPlanningFolder,
           planMode: task.config.planMode,
           autoAcceptPlan: task.config.autoAcceptPlan,
            workspaceId: task.config.workspaceId,
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
        message={`Are you sure you want to delete "${task.config.name}"?`}
        confirmLabel="Delete Draft"
        loading={deleteSubmitting}
        variant="danger"
      />
    </>
  );
}
