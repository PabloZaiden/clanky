/**
 * Shared prop types for the workspace settings form.
 */

import type { ServerSettings, ConnectionStatus } from "@/shared/settings";
import type { Workspace } from "@/shared/workspace";
import type { DeleteWorkspaceRequest } from "@/contracts/schemas/workspace";
import type { PurgeArchivedTasksResult } from "../../hooks";

/** Props for the shell workspace settings form. */
export interface WorkspaceSettingsFormProps {
  /** The workspace being edited */
  workspace: Workspace | null;
  /** Current connection status for the workspace */
  status: ConnectionStatus | null;
  /** Callback to save workspace settings */
  onSave: (name: string, settings: ServerSettings, archived: boolean) => Promise<boolean>;
  /** Callback to test connection */
  onTest: (settings: ServerSettings) => Promise<{ success: boolean; error?: string }>;
  /** Callback to purge the workspace tasks covered by the terminal-state settings action */
  onPurgeArchivedTasks?: () => Promise<PurgeArchivedTasksResult>;
  /** Callback to delete the workspace */
  onDeleteWorkspace?: (options?: DeleteWorkspaceRequest) => Promise<{ success: boolean; error?: string }>;
  /** Number of purgeable tasks shown in the terminal-state section */
  purgeableTaskCount?: number;
  /** Total number of tasks still assigned to the selected workspace */
  workspaceTaskCount?: number;
  /** Whether saving is in progress */
  saving?: boolean;
  /** Whether testing is in progress */
  testing?: boolean;
  /** Whether the terminal-state purge action is in progress */
  purgingPurgeableTasks?: boolean;
  /** Whether remote-only mode is enabled (CLANKY_REMOTE_ONLY) */
  remoteOnly?: boolean;
  /** Whether to render the inline connection status summary */
  showConnectionStatus?: boolean;
  /** Form id for external submit buttons */
  formId?: string;
  /** Called after a successful save */
  onSaved?: () => void;
  /** Called after a successful delete */
  onDeleted?: () => void;
  /** Reports current form validity */
  onValidityChange?: (isValid: boolean) => void;
}
