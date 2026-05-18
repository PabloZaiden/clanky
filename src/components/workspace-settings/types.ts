/**
 * Shared prop types for WorkspaceSettingsModal and WorkspaceSettingsForm.
 */

import type { ServerSettings, ConnectionStatus } from "../../types/settings";
import type { DeleteWorkspaceRequest, Workspace } from "../../types/workspace";
import type { PurgeArchivedLoopsResult } from "../../hooks";

export interface WorkspaceSettingsModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** The workspace being edited */
  workspace: Workspace | null;
  /** Current connection status for the workspace */
  status: ConnectionStatus | null;
  /** Callback to save workspace (name and server settings) */
  onSave: (name: string, settings: ServerSettings) => Promise<boolean>;
  /** Callback to test connection */
  onTest: (settings: ServerSettings) => Promise<{ success: boolean; error?: string }>;
  /** Callback to purge the workspace loops covered by the terminal-state settings action */
  onPurgeArchivedLoops?: () => Promise<PurgeArchivedLoopsResult>;
  /** Callback to delete the workspace */
  onDeleteWorkspace?: (options?: DeleteWorkspaceRequest) => Promise<{ success: boolean; error?: string }>;
  /** Number of purgeable loops shown in the terminal-state section */
  purgeableLoopCount?: number;
  /** Total number of loops still assigned to the selected workspace */
  workspaceLoopCount?: number;
  /** Whether saving is in progress */
  saving?: boolean;
  /** Whether testing is in progress */
  testing?: boolean;
  /** Whether the terminal-state purge action is in progress */
  purgingPurgeableLoops?: boolean;
  /** Whether remote-only mode is enabled (RALPHER_REMOTE_ONLY) */
  remoteOnly?: boolean;
}

/**
 * Shared workspace settings form used by both the shell page and the legacy modal wrapper.
 */
export interface WorkspaceSettingsFormProps {
  /** The workspace being edited */
  workspace: Workspace | null;
  /** Current connection status for the workspace */
  status: ConnectionStatus | null;
  /** Callback to save workspace (name and server settings) */
  onSave: (name: string, settings: ServerSettings) => Promise<boolean>;
  /** Callback to test connection */
  onTest: (settings: ServerSettings) => Promise<{ success: boolean; error?: string }>;
  /** Callback to purge the workspace loops covered by the terminal-state settings action */
  onPurgeArchivedLoops?: () => Promise<PurgeArchivedLoopsResult>;
  /** Callback to delete the workspace */
  onDeleteWorkspace?: (options?: DeleteWorkspaceRequest) => Promise<{ success: boolean; error?: string }>;
  /** Number of purgeable loops shown in the terminal-state section */
  purgeableLoopCount?: number;
  /** Total number of loops still assigned to the selected workspace */
  workspaceLoopCount?: number;
  /** Whether saving is in progress */
  saving?: boolean;
  /** Whether testing is in progress */
  testing?: boolean;
  /** Whether the terminal-state purge action is in progress */
  purgingPurgeableLoops?: boolean;
  /** Whether remote-only mode is enabled (RALPHER_REMOTE_ONLY) */
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
