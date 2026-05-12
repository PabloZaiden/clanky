/**
 * All confirmation and action modals for the LoopDetails view.
 * Accepts the actions hook result directly to minimize prop-threading.
 */

import type { FileContentResponse } from "../../types";
import type { LoopState } from "../../types/loop";
import type { UseLoopActionsResult } from "./use-loop-actions";
import { ConfirmModal } from "../common";
import {
  AcceptLoopModal,
  AddressCommentsModal,
  DeleteLoopModal,
  PurgeLoopModal,
  MarkMergedModal,
  ManualCompleteLoopModal,
  UpdateBranchModal,
} from "../LoopModals";

interface LoopDetailsModalsProps {
  loopName: string;
  state: LoopState;
  planContent: FileContentResponse | null;
  actions: UseLoopActionsResult;
}

export function LoopDetailsModals({ loopName, state, actions }: LoopDetailsModalsProps) {
  return (
    <>
      <DeleteLoopModal
        isOpen={actions.deleteModal}
        onClose={() => actions.setDeleteModal(false)}
        onDelete={actions.handleDelete}
      />

      <AcceptLoopModal
        isOpen={actions.acceptModal}
        onClose={() => actions.setAcceptModal(false)}
        onAccept={actions.handleAccept}
        onPush={actions.handlePush}
        restrictToAction={state.reviewMode?.completionAction}
      />

      <PurgeLoopModal
        isOpen={actions.purgeModal}
        onClose={() => actions.setPurgeModal(false)}
        onPurge={actions.handlePurge}
      />

      <MarkMergedModal
        isOpen={actions.markMergedModal}
        onClose={() => actions.setMarkMergedModal(false)}
        onMarkMerged={actions.handleMarkMerged}
      />

      <ManualCompleteLoopModal
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
        loopName={loopName}
        reviewCycle={(state.reviewMode?.reviewCycles || 0) + 1}
      />

      <ConfirmModal
        isOpen={actions.discardPlanModal}
        onClose={() => actions.setDiscardPlanModal(false)}
        onConfirm={actions.handleDiscardPlan}
        title="Discard Plan?"
        message="Are you sure you want to discard this plan? This will delete the loop and all planning work will be lost."
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
        message="Ralpher will create or reuse the pull request, keep monitoring for review feedback, and automatically push follow-up fixes until the PR is ready for manual merge."
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
        message="Ralpher will stop polling for new PR feedback so you can handle the next review updates manually."
        confirmLabel={actions.automaticPrFlowSubmitting ? "Stopping..." : "Stop Automatic PR flow"}
        cancelLabel="Cancel"
        loading={actions.automaticPrFlowSubmitting}
        variant="danger"
      />
    </>
  );
}
