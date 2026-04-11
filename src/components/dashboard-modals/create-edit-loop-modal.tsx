/**
 * Create/Edit Loop Modal — handles the create and draft-edit loop workflow,
 * including delete-draft confirmation and form submission.
 */

import { useEffect, useState } from "react";
import type {
  Loop,
  UncommittedChangesError,
  ModelInfo,
  BranchInfo,
  Workspace,
  CreateLoopRequest,
} from "../../types";
import { CreateLoopForm } from "../CreateLoopForm";
import type { CreateLoopFormActionState } from "../CreateLoopForm";
import type { CreateLoopResult } from "../../hooks/useLoops";
import { Modal } from "../common";
import { useToast } from "../../hooks";
import { DeleteDraftConfirmation } from "./delete-draft-confirmation";
import { DeleteConfirmFooter, LoopFormFooter } from "./loop-modal-footer";
import { handleCreateLoopSubmit } from "./loop-submit-handlers";

export interface CreateEditLoopModalProps {
  loops: Loop[];

  showCreateModal: boolean;
  editDraftId: string | null;
  formActionState: CreateLoopFormActionState | null;
  setFormActionState: (state: CreateLoopFormActionState | null) => void;
  onCloseCreateModal: () => void;
  onCreateLoop: (request: CreateLoopRequest) => Promise<CreateLoopResult>;
  onDeleteDraft: (loopId: string) => Promise<boolean>;
  onRefresh: () => Promise<void>;

  models: ModelInfo[];
  modelsLoading: boolean;
  lastModel: { providerID: string; modelID: string } | null;
  setLastModel: (model: { providerID: string; modelID: string } | null) => void;
  onWorkspaceChange: (workspaceId: string | null, directory: string) => void;
  planningWarning: string | null;
  branches: BranchInfo[];
  branchesLoading: boolean;
  currentBranch: string;
  defaultBranch: string;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspaceError: string | null;
  setUncommittedModal: (state: { open: boolean; loopId: string | null; error: UncommittedChangesError | null }) => void;
}

export function CreateEditLoopModal(props: CreateEditLoopModalProps) {
  const toast = useToast();
  const [deleteDraftConfirmation, setDeleteDraftConfirmation] = useState<{ loopId: string; loopName: string } | null>(null);
  const [deletingDraft, setDeletingDraft] = useState(false);

  const editLoop = props.editDraftId ? props.loops.find((l) => l.config.id === props.editDraftId) : null;
  const isEditing = !!editLoop;
  const isEditingDraft = editLoop?.state.status === "draft";
  const isConfirmingDraftDelete = deleteDraftConfirmation !== null;

  useEffect(() => {
    if (!props.showCreateModal) {
      setDeleteDraftConfirmation(null);
      setDeletingDraft(false);
    }
  }, [props.showCreateModal]);

  function openDeleteDraftConfirmation(): void {
    if (!editLoop) {
      props.onCloseCreateModal();
      toast.error("Draft could not be deleted because it no longer exists.");
      return;
    }

    setDeleteDraftConfirmation({
      loopId: editLoop.config.id,
      loopName: editLoop.config.name,
    });
  }

  async function handleDeleteDraft(): Promise<void> {
    if (!deleteDraftConfirmation) {
      return;
    }

    setDeletingDraft(true);
    try {
      const success = await props.onDeleteDraft(deleteDraftConfirmation.loopId);
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
    ? "Edit Draft Loop"
    : isEditing
      ? "Edit Draft Loop"
      : "Create New Loop";
  const modalDescription = isConfirmingDraftDelete
    ? "Confirm whether you want to permanently remove this draft from the dashboard."
    : isEditing
      ? "Update your draft loop configuration."
      : "Configure a new Ralph Loop for autonomous AI development.";

  const initialLoopData = editLoop ? {
    name: editLoop.config.name,
    directory: editLoop.config.directory,
    prompt: editLoop.config.prompt,
    model: editLoop.config.model,
    maxIterations: editLoop.config.maxIterations,
    maxConsecutiveErrors: editLoop.config.maxConsecutiveErrors,
    activityTimeoutSeconds: editLoop.config.activityTimeoutSeconds,
    baseBranch: editLoop.config.baseBranch,
    useWorktree: editLoop.config.useWorktree,
    clearPlanningFolder: editLoop.config.clearPlanningFolder,
    planMode: editLoop.config.planMode ?? false,
    autoAcceptPlan: editLoop.config.autoAcceptPlan,
    fullyAutonomous: editLoop.config.fullyAutonomous,
    workspaceId: editLoop.config.workspaceId,
  } : null;

  const submitHandlerProps = {
    workspaces: props.workspaces,
    setLastModel: props.setLastModel,
    setUncommittedModal: props.setUncommittedModal,
    onRefresh: props.onRefresh,
    onCreateLoop: props.onCreateLoop,
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
          <LoopFormFooter
            formActionState={props.formActionState}
            onOpenDeleteConfirmation={openDeleteDraftConfirmation}
          />
        )
      )}
    >
      {isConfirmingDraftDelete ? (
        <DeleteDraftConfirmation loopName={deleteDraftConfirmation.loopName} />
      ) : (
        <CreateLoopForm
          key={isEditing ? editLoop!.config.id : "create-new-loop"}
          editLoopId={isEditing ? editLoop!.config.id : undefined}
          initialLoopData={initialLoopData}
          isEditingDraft={isEditingDraft}
          renderActions={props.setFormActionState}
          onSubmit={async (request) => await handleCreateLoopSubmit(submitHandlerProps, editLoop, request, toast)}
          onCancel={props.onCloseCreateModal}
          models={props.models}
          modelsLoading={props.modelsLoading}
          lastModel={props.lastModel}
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
