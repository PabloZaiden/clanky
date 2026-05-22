/**
 * Delete draft confirmation panel — shown inside the modal when the user
 * clicks "Delete" on a draft task, asking them to confirm the deletion.
 */

interface DeleteDraftConfirmationProps {
  taskName: string;
}

export function DeleteDraftConfirmation({ taskName }: DeleteDraftConfirmationProps) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900/60 dark:bg-red-950/30">
      <h3 className="text-sm font-semibold text-red-800 dark:text-red-200">
        Delete Draft?
      </h3>
      <p className="mt-2 text-sm text-red-700 dark:text-red-300">
        Are you sure you want to permanently delete "{taskName}"?
      </p>
    </div>
  );
}
