/**
 * All confirmation and action modals for the TaskDetails view.
 * Accepts the actions hook result directly to minimize prop-threading.
 */

import type { FileContentResponse } from "../../types";
import type { TaskState } from "../../types/task";
import type { UseTaskActionsResult } from "./use-task-actions";
import { ConfirmModal } from "@pablozaiden/webapp/web";
import {
  AcceptTaskModal,
  AddressCommentsModal,
  DeleteTaskModal,
  PurgeTaskModal,
  MarkMergedModal,
  ManualCompleteTaskModal,
  UpdateBranchModal,
} from "../TaskModals";

interface TaskDetailsModalsProps {
  taskName: string;
  state: TaskState;
  planContent: FileContentResponse | null;
  actions: UseTaskActionsResult;
  canPushToRemote: boolean;
  remoteStatusLoading: boolean;
}

export function TaskDetailsModals({
  taskName,
  state,
  actions,
  canPushToRemote,
  remoteStatusLoading,
}: TaskDetailsModalsProps) {
  return (
    <>
      <DeleteTaskModal
        isOpen={actions.deleteModal}
        onClose={() => actions.setDeleteModal(false)}
        onDelete={actions.handleDelete}
      />

      <AcceptTaskModal
        isOpen={actions.acceptModal}
        acceptedBranch={state.git?.workingBranch}
        onClose={() => actions.setAcceptModal(false)}
        onAccept={actions.handleAccept}
        onPush={actions.handlePush}
        canPushToRemote={canPushToRemote}
        remoteStatusLoading={remoteStatusLoading}
      />

      <PurgeTaskModal
        isOpen={actions.purgeModal}
        onClose={() => actions.setPurgeModal(false)}
        onPurge={actions.handlePurge}
      />

      <MarkMergedModal
        isOpen={actions.markMergedModal}
        onClose={() => actions.setMarkMergedModal(false)}
        onMarkMerged={actions.handleMarkMerged}
      />

      <ConfirmModal
        isOpen={actions.closeLocalModal}
        onClose={() => actions.setCloseLocalModal(false)}
        onConfirm={actions.handleCloseLocal}
        title="Close Local Task?"
        message={`This keeps the local commits on ${state.git?.workingBranch ?? "the working branch"} and disables further follow-up comments for this task. No push or PR action will run. Use Purge Task if you also want Clanky to remove tracked branch/worktree artifacts.`}
        confirmLabel="Close Local Task"
        cancelLabel="Cancel"
        variant="primary"
      />

      <ManualCompleteTaskModal
        isOpen={actions.manualCompleteModal}
        onClose={() => actions.setManualCompleteModal(false)}
        onManualComplete={actions.handleManualComplete}
      />

      <UpdateBranchModal
        isOpen={actions.updateBranchModal}
        onClose={() => actions.setUpdateBranchModal(false)}
        onUpdateBranch={actions.handleUpdateBranch}
      />

      <AddressCommentsModal
        isOpen={actions.addressCommentsModal}
        onClose={() => actions.setAddressCommentsModal(false)}
        onSubmit={actions.handleAddressComments}
        taskName={taskName}
        reviewCycle={(state.reviewMode?.reviewCycles || 0) + 1}
      />

      <ConfirmModal
        isOpen={actions.discardPlanModal}
        onClose={() => actions.setDiscardPlanModal(false)}
        onConfirm={actions.handleDiscardPlan}
        title="Discard Plan?"
        message="Are you sure you want to discard this plan? This will delete the task and all planning work will be lost."
        confirmLabel={actions.planActionSubmitting ? "Discarding..." : "Discard"}
        cancelLabel="Cancel"
        loading={actions.planActionSubmitting}
        variant="danger"
      />

      <ConfirmModal
        isOpen={actions.startAutomaticPrFlowModal}
        onClose={() => actions.setStartAutomaticPrFlowModal(false)}
        onConfirm={actions.handleStartAutomaticPrFlow}
        title="Start Automatic PR flow?"
        message="Clanky will create or reuse the pull request, keep monitoring for review feedback, and automatically push follow-up fixes until the PR is ready for manual merge."
        confirmLabel={actions.automaticPrFlowSubmitting ? "Starting..." : "Start Automatic PR flow"}
        cancelLabel="Cancel"
        loading={actions.automaticPrFlowSubmitting}
        variant="primary"
      />

      <ConfirmModal
        isOpen={actions.stopAutomaticPrFlowModal}
        onClose={() => actions.setStopAutomaticPrFlowModal(false)}
        onConfirm={actions.handleStopAutomaticPrFlow}
        title="Stop Automatic PR flow?"
        message="Clanky will stop polling for new PR feedback so you can handle the next review updates manually."
        confirmLabel={actions.automaticPrFlowSubmitting ? "Stopping..." : "Stop Automatic PR flow"}
        cancelLabel="Cancel"
        loading={actions.automaticPrFlowSubmitting}
        variant="danger"
      />
    </>
  );
}
