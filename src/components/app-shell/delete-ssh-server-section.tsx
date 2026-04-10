import { useState } from "react";
import { Button, ConfirmModal } from "../common";
import { useToast } from "../../hooks";
import type { SshServer } from "../../types";
import { TrashIcon } from "../workspace-settings";

interface DeleteSshServerSectionProps {
  server: SshServer;
  relatedSessionCount: number;
  disabled: boolean;
  onDeleteServer: () => Promise<boolean>;
  onDeleted?: () => void;
}

export function DeleteSshServerSection({
  server,
  relatedSessionCount,
  disabled,
  onDeleteServer,
  onDeleted,
}: DeleteSshServerSectionProps) {
  const toast = useToast();
  const [showConfirm, setShowConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const confirmMessage = relatedSessionCount === 0
    ? `Delete "${server.config.name}"? This removes the saved SSH server metadata from Ralpher and any saved browser credential for this server.`
    : `Delete "${server.config.name}" and its ${relatedSessionCount} standalone session${relatedSessionCount === 1 ? "" : "s"}? This removes the saved SSH server metadata from Ralpher, any saved browser credential for this server, and cannot be undone.`;

  async function handleDelete() {
    setDeleting(true);
    try {
      const deleted = await onDeleteServer();
      if (!deleted) {
        setDeleting(false);
        toast.error(`Failed to delete SSH server "${server.config.name}"`);
        return;
      }

      setShowConfirm(false);
      setDeleting(false);
      onDeleted?.();
    } catch (error) {
      setDeleting(false);
      toast.error(String(error));
    }
  }

  return (
    <div className="mt-6 border-t border-gray-200 pt-6 dark:border-gray-700">
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-900/20">
        <h3 className="mb-2 text-sm font-medium text-red-800 dark:text-red-200">Delete SSH Server</h3>
        <p className="mb-4 text-sm text-red-700 dark:text-red-300">
          {relatedSessionCount === 0
            ? "Remove this SSH server from Ralpher when you no longer need its saved connection details."
            : `This also removes ${relatedSessionCount} standalone session${relatedSessionCount === 1 ? "" : "s"} associated with this server.`}
          {" "}Any saved browser credential for this server is cleared as part of deletion.
        </p>
        <Button
          type="button"
          variant="danger"
          size="sm"
          onClick={() => setShowConfirm(true)}
          loading={deleting}
          disabled={disabled || deleting}
        >
          <TrashIcon className="mr-2 h-4 w-4" />
          Delete SSH Server
        </Button>
      </div>

      <ConfirmModal
        isOpen={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={handleDelete}
        title="Delete SSH Server"
        message={confirmMessage}
        confirmLabel="Delete Server"
        loading={deleting}
        variant="danger"
      />
    </div>
  );
}
