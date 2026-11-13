/**
 * Shared prop types for the workspace settings form.
 */

import type { ServerSettings, ConnectionStatus } from "@/shared/settings";
import type { Workspace } from "@/shared/workspace";
import type { ExecutionHostRef } from "@/shared";
import type { DeleteWorkspaceRequest, UpdateWorkspaceRequest } from "@/contracts/schemas/workspace";

/** Props for the shell workspace settings form. */
export interface WorkspaceSettingsFormProps {
  /** The workspace being edited */
  workspace: Workspace;
  /** Current connection status for the workspace */
  status: ConnectionStatus | null;
  /** Callback to save workspace settings */
  onSave: (request: UpdateWorkspaceRequest) => Promise<boolean>;
  /** Refresh workspace surfaces after its icon changes */
  onWorkspaceIconChanged?: () => Promise<void>;
  /** Callback to test connection */
  onTest: (
    settings: ServerSettings,
    executionHost: ExecutionHostRef | null,
  ) => Promise<{ success: boolean; error?: string }>;
  /** Callback to delete the workspace */
  onDeleteWorkspace?: (options?: DeleteWorkspaceRequest) => Promise<{ success: boolean; error?: string }>;
  /** Whether saving is in progress */
  saving?: boolean;
  /** Whether testing is in progress */
  testing?: boolean;
  /** Whether remote-only mode is enabled (CLANKY_REMOTE_ONLY) */
  remoteOnly?: boolean;
  /** Form id for external submit buttons */
  formId?: string;
  /** Called after a successful delete */
  onDeleted?: () => void;
}
