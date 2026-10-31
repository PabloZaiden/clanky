/**
 * Delete workspace danger panel within workspace settings.
 */

import { useState } from "react";
import { Button, CheckboxField, ConfirmModal, SettingsFieldRow, useToast } from "@pablozaiden/webapp/web";
import type { Workspace } from "@/shared/workspace";
import type { DeleteWorkspaceRequest } from "@/contracts/schemas/workspace";
import { isAutoProvisionedWorkspace } from "../../lib/workspace-deletion-safety";

interface DeleteWorkspaceSectionProps {
  workspace: Workspace;
  onDeleteWorkspace: (options?: DeleteWorkspaceRequest) => Promise<{ success: boolean; error?: string }>;
  workspaceTaskCount: number;
  saving: boolean;
  onDeleted?: () => void;
}

export function DeleteWorkspaceSection({
  workspace,
  onDeleteWorkspace,
  workspaceTaskCount,
  saving,
  onDeleted,
}: DeleteWorkspaceSectionProps) {
  const toast = useToast();
  const [showConfirm, setShowConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteServerDirectory, setDeleteServerDirectory] = useState(true);
  const canDeleteServerDirectory = isAutoProvisionedWorkspace(workspace);

  const disabled = saving || deleting || workspaceTaskCount > 0;

  async function handleDelete() {
    setDeleting(true);
    try {
      const options: DeleteWorkspaceRequest = {};
      if (deleteServerDirectory && canDeleteServerDirectory) {
        options.deleteServerDirectory = true;
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
    <>
      <SettingsFieldRow title="Delete workspace" danger
        description={workspaceTaskCount > 0
                ? `Delete the remaining ${workspaceTaskCount} task${workspaceTaskCount === 1 ? "" : "s"} in this workspace before removing it from Clanky.`
                : "Chats in Trash and their managed worktrees will be permanently deleted."}
        actions={<Button
            type="button"
            tone="danger"
            disabled={disabled}
            onClick={() => {
              setDeleteServerDirectory(true);
              setShowConfirm(true);
            }}
          >
            Delete
          </Button>} />

      <ConfirmModal
        isOpen={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={handleDelete}
        title="Delete Workspace"
        message={
          canDeleteServerDirectory
            ? `Are you sure you want to delete workspace "${workspace.name}"? Its chats in Trash will also be permanently deleted.`
            : `Are you sure you want to delete workspace "${workspace.name}"? Its chats in Trash and their managed worktrees will also be permanently deleted. Other workspace files are kept.`
        }
        confirmLabel="Delete"
        loading={deleting}
        variant="danger"
      >
        {canDeleteServerDirectory && workspace.sourceDirectory && (
          <CheckboxField label="Also delete the server directory" hint={workspace.sourceDirectory}
            checked={deleteServerDirectory} onChange={(event) => setDeleteServerDirectory(event.currentTarget.checked)} />
        )}
      </ConfirmModal>
    </>
  );
}
