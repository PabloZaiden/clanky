/**
 * Create/Edit Task Modal — handles the create and draft-edit task workflow,
 * including delete-draft confirmation and form submission.
 */

import { useEffect, useState } from "react";
import type {
  CheapModelSelection,
  Task,
  UncommittedChangesError,
  ModelInfo,
  ModelConfig,
  BranchInfo,
  Workspace,
  CreateTaskRequest,
} from "../../types";
import { CreateTaskForm } from "../CreateTaskForm";
import type { CreateTaskFormActionState } from "../CreateTaskForm";
import type { CreateTaskResult } from "../../hooks/useTasks";
import { Modal } from "../common";
import { useToast } from "../../hooks";
import { DeleteDraftConfirmation } from "./delete-draft-confirmation";
import { DeleteConfirmFooter, TaskFormFooter } from "./task-modal-footer";
import { handleCreateTaskSubmit } from "./task-submit-handlers";

export interface CreateEditTaskModalProps {
  tasks: Task[];

  showCreateModal: boolean;
  editDraftId: string | null;
  formActionState: CreateTaskFormActionState | null;
  setFormActionState: (state: CreateTaskFormActionState | null) => void;
  onCloseCreateModal: () => void;
  onCreateTask: (request: CreateTaskRequest) => Promise<CreateTaskResult>;
  onDeleteDraft: (taskId: string) => Promise<boolean>;
  onRefresh: () => Promise<void>;

  models: ModelInfo[];
  modelsLoading: boolean;
  lastModel: ModelConfig | null;
  lastCheapModel: CheapModelSelection | null;
  setLastModel: (model: ModelConfig | null) => void;
  setLastCheapModel: (selection: CheapModelSelection | null) => void;
  onWorkspaceChange: (workspaceId: string | null, directory: string) => void;
  planningWarning: string | null;
  branches: BranchInfo[];
  branchesLoading: boolean;
  currentBranch: string;
  defaultBranch: string;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspaceError: string | null;
  setUncommittedModal: (state: { open: boolean; taskId: string | null; error: UncommittedChangesError | null }) => void;
}

export function CreateEditTaskModal(props: CreateEditTaskModalProps) {
  const toast = useToast();
  const [deleteDraftConfirmation, setDeleteDraftConfirmation] = useState<{ taskId: string; taskName: string } | null>(null);
  const [deletingDraft, setDeletingDraft] = useState(false);

  const editTask = props.editDraftId ? props.tasks.find((l) => l.config.id === props.editDraftId) : null;
  const isEditing = !!editTask;
  const isEditingDraft = editTask?.state.status === "draft";
  const isConfirmingDraftDelete = deleteDraftConfirmation !== null;

  useEffect(() => {
    if (!props.showCreateModal) {
      setDeleteDraftConfirmation(null);
      setDeletingDraft(false);
    }
  }, [props.showCreateModal]);

  function openDeleteDraftConfirmation(): void {
    if (!editTask) {
      props.onCloseCreateModal();
      toast.error("Draft could not be deleted because it no longer exists.");
      return;
    }

    setDeleteDraftConfirmation({
      taskId: editTask.config.id,
      taskName: editTask.config.name,
    });
  }

  async function handleDeleteDraft(): Promise<void> {
    if (!deleteDraftConfirmation) {
      return;
    }

    setDeletingDraft(true);
    try {
      const success = await props.onDeleteDraft(deleteDraftConfirmation.taskId);
      if (!success) {
        toast.error("Failed to delete draft");
        return;
      }

      setDeleteDraftConfirmation(null);
      props.onCloseCreateModal();
    } finally {
      setDeletingDraft(false);
    }
  }

  const modalTitle = isConfirmingDraftDelete
    ? "Edit Draft Task"
    : isEditing
      ? "Edit Draft Task"
      : "Create New Task";
  const modalDescription = isConfirmingDraftDelete
    ? "Confirm whether you want to permanently remove this draft from the dashboard."
    : isEditing
      ? "Update your draft task configuration."
      : "Configure a new Clanky Task for autonomous AI development.";

  const initialTaskData = editTask ? {
    name: editTask.config.name,
    directory: editTask.config.directory,
     prompt: editTask.config.prompt,
     model: editTask.config.model,
     cheapModel: editTask.config.cheapModel,
     maxIterations: editTask.config.maxIterations,
    maxConsecutiveErrors: editTask.config.maxConsecutiveErrors,
    activityTimeoutSeconds: editTask.config.activityTimeoutSeconds,
    baseBranch: editTask.config.baseBranch,
    useWorktree: editTask.config.useWorktree,
    clearPlanningFolder: editTask.config.clearPlanningFolder,
    planMode: editTask.config.planMode ?? false,
    autoAcceptPlan: editTask.config.autoAcceptPlan,
    fullyAutonomous: editTask.config.fullyAutonomous,
    workspaceId: editTask.config.workspaceId,
  } : null;

  const submitHandlerProps = {
    workspaces: props.workspaces,
    setLastModel: props.setLastModel,
    setLastCheapModel: props.setLastCheapModel,
    setUncommittedModal: props.setUncommittedModal,
    onRefresh: props.onRefresh,
    onCreateTask: props.onCreateTask,
  };

  return (
    <Modal
      isOpen={props.showCreateModal}
      onClose={props.onCloseCreateModal}
      title={modalTitle}
      description={modalDescription}
      size="lg"
      footer={props.formActionState && (
        isConfirmingDraftDelete ? (
          <DeleteConfirmFooter
            deletingDraft={deletingDraft}
            onKeepDraft={() => setDeleteDraftConfirmation(null)}
            onDeleteDraft={handleDeleteDraft}
          />
        ) : (
          <TaskFormFooter
            formActionState={props.formActionState}
            onOpenDeleteConfirmation={openDeleteDraftConfirmation}
          />
        )
      )}
    >
      {isConfirmingDraftDelete ? (
        <DeleteDraftConfirmation taskName={deleteDraftConfirmation.taskName} />
      ) : (
        <CreateTaskForm
          key={isEditing ? editTask!.config.id : "create-new-task"}
          editTaskId={isEditing ? editTask!.config.id : undefined}
          initialTaskData={initialTaskData}
          isEditingDraft={isEditingDraft}
          renderActions={props.setFormActionState}
          onSubmit={async (request) => await handleCreateTaskSubmit(submitHandlerProps, editTask, request, toast)}
          onCancel={props.onCloseCreateModal}
           models={props.models}
           modelsLoading={props.modelsLoading}
           lastModel={props.lastModel}
           lastCheapModel={props.lastCheapModel}
           onWorkspaceChange={props.onWorkspaceChange}
          planningWarning={props.planningWarning}
          branches={props.branches}
          branchesLoading={props.branchesLoading}
          currentBranch={props.currentBranch}
          defaultBranch={props.defaultBranch}
          workspaces={props.workspaces}
          workspacesLoading={props.workspacesLoading}
          workspaceError={props.workspaceError}
        />
      )}
    </Modal>
  );
}
