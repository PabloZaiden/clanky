import { useState } from "react";
import type { DeleteWorkspaceRequest, Workspace, SshServer } from "../../types";
import type { WorkspaceGroup } from "../../hooks/useTaskGrouping";
import { getServerLabel } from "../../types/settings";
import { ConfirmModal } from "@pablozaiden/webapp/web";
import { useToast } from "../../hooks";
import { getStoredSshCredentialToken } from "../../lib/ssh-browser-credentials";
import { isAutoProvisionedWorkspace } from "../../lib/workspace-deletion-safety";
import { WorkspaceGearIcon } from "./workspace-gear-icon";

export interface EmptyWorkspacesSectionProps {
  workspaceGroups: WorkspaceGroup[];
  registeredSshServers: readonly SshServer[];
  onOpenWorkspaceSettings: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string, options?: DeleteWorkspaceRequest) => Promise<{ success: boolean; error?: string }>;
}

/** Renders the "Empty Workspaces" section with delete confirmation */
export function EmptyWorkspacesSection({
  workspaceGroups,
  registeredSshServers,
  onOpenWorkspaceSettings,
  onDeleteWorkspace,
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
        {emptyGroups.map(({ workspace }) => (
          <div key={workspace.id} className="flex min-w-0 items-start gap-2 rounded-md bg-gray-100 px-3 py-2 dark:bg-neutral-800">
            <div className="min-w-0">
              <div className="break-words text-sm text-gray-700 dark:text-gray-300 [overflow-wrap:anywhere]">{workspace.name}</div>
              <div
                className="break-words text-xs text-gray-500 dark:text-gray-400 [overflow-wrap:anywhere]"
                title={getServerLabel(workspace.serverSettings, registeredSshServers)}
              >
                {getServerLabel(workspace.serverSettings, registeredSshServers)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onOpenWorkspaceSettings(workspace.id)}
              className="p-1 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors"
              title="Workspace Settings"
            >
              <WorkspaceGearIcon />
            </button>
            <button
              onClick={() => {
                setDeleteWorkspace(workspace);
                setDeleteServerDirectory(true);
              }}
              className="p-1 text-gray-400 hover:text-red-500 dark:text-gray-500 dark:hover:text-red-400 transition-colors"
              title="Delete empty workspace"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
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
              if (deleteWorkspace.sshServerId) {
                options.credentialToken = await getStoredSshCredentialToken(deleteWorkspace.sshServerId);
              }
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
