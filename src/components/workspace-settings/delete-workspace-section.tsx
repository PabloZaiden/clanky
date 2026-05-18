/**
 * Delete workspace danger panel within workspace settings.
 */

import { useState } from "react";
import { Button, ConfirmModal } from "../common";
import { useToast } from "../../hooks";
import type { DeleteWorkspaceRequest, Workspace } from "../../types/workspace";
import { getStoredSshCredentialToken } from "../../lib/ssh-browser-credentials";
import { TrashIcon } from "./icons";

interface DeleteWorkspaceSectionProps {
  workspace: Workspace;
  onDeleteWorkspace: (options?: DeleteWorkspaceRequest) => Promise<{ success: boolean; error?: string }>;
  workspaceLoopCount: number;
  saving: boolean;
  onDeleted?: () => void;
}

function canDeleteProvisionedServerDirectory(workspace: Workspace): boolean {
  return Boolean(workspace.sourceDirectory?.trim() && workspace.sshServerId?.trim() && workspace.basePath?.trim());
}

export function DeleteWorkspaceSection({
  workspace,
  onDeleteWorkspace,
  workspaceLoopCount,
  saving,
  onDeleted,
}: DeleteWorkspaceSectionProps) {
  const toast = useToast();
  const [showConfirm, setShowConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteServerDirectory, setDeleteServerDirectory] = useState(true);
  const canDeleteServerDirectory = canDeleteProvisionedServerDirectory(workspace);

  const disabled = saving || deleting || workspaceLoopCount > 0;

  async function handleDelete() {
    setDeleting(true);
    try {
      const options: DeleteWorkspaceRequest = {};
      if (deleteServerDirectory && canDeleteServerDirectory) {
        options.deleteServerDirectory = true;
        if (workspace.sshServerId) {
          options.credentialToken = await getStoredSshCredentialToken(workspace.sshServerId);
        }
      }
      const result = await onDeleteWorkspace(options);
      setShowConfirm(false);
      if (!result.success) {
        toast.error(result.error || "Failed to delete workspace");
        return;
      }

      onDeleted?.();
    } catch (error) {
      setShowConfirm(false);
      toast.error(String(error));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 pt-6 mt-6">
      <div className="p-4 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-900/20">
        <h3 className="text-sm font-medium text-red-800 dark:text-red-200 mb-2">
          Delete Workspace
        </h3>
        <p className="text-sm text-red-700 dark:text-red-300 mb-4">
          {workspaceLoopCount > 0
            ? `Delete the remaining ${workspaceLoopCount} loop${workspaceLoopCount === 1 ? "" : "s"} in this workspace before removing it from Ralpher.`
            : "Remove this workspace from Ralpher now that it no longer contains loops."}
          {" "}This only removes the workspace record and does not delete files on disk.
        </p>
        <Button
          type="button"
          variant="danger"
          size="sm"
          onClick={() => {
            setDeleteServerDirectory(true);
            setShowConfirm(true);
          }}
          loading={deleting}
          disabled={disabled}
        >
          <TrashIcon className="w-4 h-4 mr-2" />
          Delete Workspace
        </Button>
      </div>

      <ConfirmModal
        isOpen={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={handleDelete}
        title="Delete Workspace"
        message={
          canDeleteServerDirectory
            ? `Are you sure you want to delete workspace "${workspace.name}"? This removes it from Ralpher.`
            : `Are you sure you want to delete workspace "${workspace.name}"? This only removes it from Ralpher and does not delete files on disk.`
        }
        confirmLabel="Delete"
        loading={deleting}
        variant="danger"
      >
        {canDeleteServerDirectory && workspace.sourceDirectory && (
          <label className="mt-4 flex items-start gap-3 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={deleteServerDirectory}
              onChange={(event) => setDeleteServerDirectory(event.currentTarget.checked)}
              className="mt-1"
            />
            <span>
              Also delete the server directory{" "}
              <span className="font-mono break-all">{workspace.sourceDirectory}</span>
            </span>
          </label>
        )}
      </ConfirmModal>
    </div>
  );
}
