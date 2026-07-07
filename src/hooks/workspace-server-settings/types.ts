import type { ServerSettings } from "../../types/settings";
import type { Workspace } from "../../types/workspace";
import type { ConnectionStatus } from "../../types/settings";

export interface UseWorkspaceServerSettingsResult {
  /** Full workspace data (name, directory, serverSettings) - fetched fresh from API */
  workspace: Workspace | null;
  /** Current server settings for the workspace (alias for workspace.serverSettings) */
  settings: ServerSettings | null;
  /** Current connection status for the workspace */
  status: ConnectionStatus | null;
  /** Whether settings are loading */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /** Whether a save operation is in progress */
  saving: boolean;
  /** Whether a test operation is in progress */
  testing: boolean;
  /** Refresh settings from the server */
  refresh: () => Promise<void>;
  /** Update server settings for the workspace */
  updateSettings: (settings: ServerSettings) => Promise<boolean>;
  /** Update workspace name */
  updateName: (name: string) => Promise<boolean>;
  /** Update workspace settings fields */
  updateWorkspace: (name: string, settings: ServerSettings, archived: boolean) => Promise<boolean>;
  /** Test connection with provided settings (uses workspace's current settings if not provided) */
  testConnection: (settings?: ServerSettings) => Promise<{ success: boolean; error?: string }>;
}
