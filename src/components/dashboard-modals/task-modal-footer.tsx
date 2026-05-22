/**
 * Task modal footer — renders the action buttons for both the normal form view
 * and the delete-draft confirmation view.
 */

import type { CreateTaskFormActionState } from "../CreateTaskForm";
import { getComposeDraftActionLabel, getComposeSubmitActionLabel } from "../CreateTaskForm";
import { Button } from "../common";

interface DeleteConfirmFooterProps {
  deletingDraft: boolean;
  onKeepDraft: () => void;
  onDeleteDraft: () => void;
}

export function DeleteConfirmFooter({ deletingDraft, onKeepDraft, onDeleteDraft }: DeleteConfirmFooterProps) {
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        onClick={onKeepDraft}
        disabled={deletingDraft}
      >
        Keep Draft
      </Button>
      <Button
        type="button"
        variant="danger"
        onClick={onDeleteDraft}
        loading={deletingDraft}
      >
        Delete
      </Button>
    </>
  );
}

interface TaskFormFooterProps {
  formActionState: CreateTaskFormActionState;
  onOpenDeleteConfirmation: () => void;
}

export function TaskFormFooter({ formActionState, onOpenDeleteConfirmation }: TaskFormFooterProps) {
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        onClick={formActionState.onCancel}
        disabled={formActionState.isSubmitting}
      >
        Cancel
      </Button>
      {formActionState.isEditingDraft && (
        <Button
          type="button"
          variant="danger"
          onClick={onOpenDeleteConfirmation}
          disabled={formActionState.isSubmitting}
        >
          Delete
        </Button>
      )}
      {(!formActionState.isEditing || formActionState.isEditingDraft) && (
        <Button
          type="button"
          variant="secondary"
          onClick={formActionState.onSaveAsDraft}
          disabled={formActionState.isSubmitting || !formActionState.canSaveDraft}
          loading={formActionState.isSubmitting}
        >
          {getComposeDraftActionLabel(formActionState.isEditingDraft)}
        </Button>
      )}
      <Button
        type="button"
        onClick={formActionState.onSubmit}
        loading={formActionState.isSubmitting}
        disabled={!formActionState.canSubmit}
      >
        {getComposeSubmitActionLabel({
          isEditing: formActionState.isEditing,
        })}
      </Button>
    </>
  );
}
