import { useState } from "react";
import type { ExecutionHostDescriptor, Workspace } from "@/shared";
import type { DeleteWorkspaceRequest } from "@/contracts/schemas/workspace";
import type { WorkspaceGroup } from "../../hooks/useTaskGrouping";
import { getWorkspaceServerLabel } from "../../lib/workspace-label";
import { ActionMenu, ConfirmModal, useToast } from "@pablozaiden/webapp/web";
import { isAutoProvisionedWorkspace } from "../../lib/workspace-deletion-safety";
import { isEffectivelyPrivate, shouldObscurePrivateItem } from "../../lib/private-items";
import { usePrivateItemReveal } from "../../hooks/usePrivateItemReveal";

export interface EmptyWorkspacesSectionProps {
  workspaceGroups: WorkspaceGroup[];
  executionTargets: readonly ExecutionHostDescriptor[];
  onOpenWorkspaceSettings: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string, options?: DeleteWorkspaceRequest) => Promise<{ success: boolean; error?: string }>;
  showPrivateItems?: boolean;
}

function EmptyWorkspaceEntry({
  workspace,
  executionTargets,
  privateHidden,
  onOpenSettings,
  onRequestDelete,
}: {
  workspace: Workspace;
  executionTargets: readonly ExecutionHostDescriptor[];
  privateHidden: boolean;
  onOpenSettings: () => void;
  onRequestDelete: () => void;
}) {
  const reveal = usePrivateItemReveal(privateHidden);

  return (
    <div
      className={`flex min-w-0 items-start gap-2 rounded-md bg-gray-100 px-3 py-2 dark:bg-neutral-800 ${reveal.className}`}
      onPointerEnter={reveal.onPointerEnter}
      onPointerLeave={reveal.onPointerLeave}
    >
      <div className="min-w-0">
        <div className="break-words text-sm text-gray-700 dark:text-gray-300 [overflow-wrap:anywhere]">
          {workspace.name}
        </div>
        <div
          className="break-words text-xs text-gray-500 dark:text-gray-400 [overflow-wrap:anywhere]"
          title={getWorkspaceServerLabel(workspace, executionTargets)}
        >
          {getWorkspaceServerLabel(workspace, executionTargets)}
        </div>
      </div>
      <ActionMenu
        ariaLabel={privateHidden ? "Workspace actions" : `Actions for ${workspace.name}`}
        triggerVariant="ghost"
        triggerSize="compact"
        items={[
          {
            id: "settings",
            label: "Settings",
            onAction: onOpenSettings,
          },
          {
            id: "delete",
            label: "Delete",
            destructive: true,
            onAction: onRequestDelete,
          },
        ]}
      />
    </div>
  );
}

/** Renders the "Empty Workspaces" section with delete confirmation */
export function EmptyWorkspacesSection({
  workspaceGroups,
  executionTargets,
  onOpenWorkspaceSettings,
  onDeleteWorkspace,
  showPrivateItems = false,
}: EmptyWorkspacesSectionProps) {
  const toast = useToast();
  const [deleteWorkspace, setDeleteWorkspace] = useState<Workspace | null>(null);
  const [deletingWorkspace, setDeletingWorkspace] = useState(false);
  const [deleteServerDirectory, setDeleteServerDirectory] = useState(true);

  const emptyGroups = workspaceGroups.filter((g) => g.tasks.length === 0);
  if (emptyGroups.length === 0) return null;

  return (
    <div className="mb-10">
      <div className="flex items-center gap-3 mb-4 pb-2 border-b border-gray-200 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">
          Empty Workspaces
        </h2>
      </div>
      <div className="flex flex-wrap gap-2">
        {emptyGroups.map(({ workspace }) => {
          const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(workspace), showPrivateItems);
          return (
            <EmptyWorkspaceEntry
              key={workspace.id}
              workspace={workspace}
              executionTargets={executionTargets}
              privateHidden={privateHidden}
              onOpenSettings={() => onOpenWorkspaceSettings(workspace.id)}
              onRequestDelete={() => {
                setDeleteWorkspace(workspace);
                setDeleteServerDirectory(true);
              }}
            />
          );
        })}
      </div>

      <ConfirmModal
        isOpen={deleteWorkspace !== null}
        onClose={() => setDeleteWorkspace(null)}
        onConfirm={async () => {
          if (!deleteWorkspace) return;
          setDeletingWorkspace(true);
          try {
            const options: DeleteWorkspaceRequest = {};
            if (deleteServerDirectory && isAutoProvisionedWorkspace(deleteWorkspace)) {
              options.deleteServerDirectory = true;
            }
            const result = await onDeleteWorkspace(deleteWorkspace.id, options);
            if (!result.success) {
              toast.error(result.error || "Failed to delete workspace");
            }
          } finally {
            setDeletingWorkspace(false);
            setDeleteWorkspace(null);
          }
        }}
        title="Delete Workspace"
        message={`Are you sure you want to delete workspace "${deleteWorkspace?.name ?? ""}"?`}
        confirmLabel="Delete"
        loading={deletingWorkspace}
        variant="danger"
      >
        {deleteWorkspace?.sourceDirectory && isAutoProvisionedWorkspace(deleteWorkspace) && (
          <label className="mt-4 flex items-start gap-3 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={deleteServerDirectory}
              onChange={(event) => setDeleteServerDirectory(event.currentTarget.checked)}
              className="mt-1"
            />
            <span>
              Also delete the server directory{" "}
              <span className="font-mono break-all">{deleteWorkspace.sourceDirectory}</span>
            </span>
          </label>
        )}
      </ConfirmModal>
    </div>
  );
}
